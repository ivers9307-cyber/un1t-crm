// POST /api/contacts/import/commit
//
// Mig 095 + 096. Master-only contact CSV import.
//
// Two paths based on row count:
//
//   ≤ SYNC_LIMIT (1000) — write inline, return final stats. Wizard
//     jumps straight to the "Done" step.
//
//   > SYNC_LIMIT (up to ASYNC_LIMIT = 50_000) — enqueue: insert
//     contact_imports row with status='pending' + payload, publish a
//     QStash push (QSTASH.4 — the worker at
//     /api/webhooks/qstash/contact-imports usually starts the job in
//     ~seconds), and return immediately with import_id. The wizard
//     polls /api/contacts/imports/[id] until status flips to
//     'completed' / 'failed'. The cron sweeper at
//     /api/cron/process-contact-imports remains the delivery
//     guarantee (publish failures, QStash outages, stuck-recovery).
//
// Body: { mapping, rows, batch_tag, source_filename, location_id?, resolutions? }

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { runImportCommit } from '@/lib/contact-import-runner'
import { publishQueuePush, CONTACT_IMPORTS_WORKER_PATH } from '@/lib/qstash'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SYNC_LIMIT = 1000
const ASYNC_LIMIT = 50_000

const Body = z.object({
  mapping: z.record(z.string().nullable()),
  rows: z.array(z.record(z.unknown())).min(1).max(ASYNC_LIMIT),
  batch_tag: z.string().max(200).optional(),
  source_filename: z.string().max(500).optional(),
  location_id: uuidLike.optional(),
  resolutions: z.record(z.enum(['row_wins', 'preserve_existing', 'skip'])).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!user.isMaster && user.role !== 'master') {
    return NextResponse.json({
      success: false,
      error: 'Only a master account can import contacts.',
    }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { mapping, rows, batch_tag, source_filename, location_id, resolutions } = validation.data
  const targetLocationId = location_id || user.activeLocation?.id
  if (!targetLocationId) {
    return NextResponse.json({ success: false, error: 'No target location.' }, { status: 400 })
  }
  const db = createServerClient()
  const { data: targetLoc } = await db
    .from('locations').select('id').eq('id', targetLocationId).single()
  if (!targetLoc) {
    return NextResponse.json({ success: false, error: 'Target location not found.' }, { status: 404 })
  }

  const isAsync = rows.length > SYNC_LIMIT

  // Open the batch envelope. For async we stash the full payload
  // so the cron worker can pick it up later.
  const { data: batch, error: batchErr } = await db
    .from('contact_imports')
    .insert({
      location_id: targetLocationId,
      actor_user_id: user.id,
      source_filename: source_filename || null,
      mapping,
      batch_tag: batch_tag || null,
      total_rows: rows.length,
      status: isAsync ? 'pending' : 'completed',
      payload: isAsync ? { mapping, rows, batchTag: batch_tag || null, resolutions: resolutions || {} } : null,
    })
    .select()
    .single()
  if (batchErr) {
    return NextResponse.json({ success: false, error: `Could not start import: ${batchErr.message}` }, { status: 500 })
  }

  // Async path: return now, a queue consumer will fill in counts.
  if (isAsync) {
    // QSTASH.4 — push delivery. Nudge QStash to deliver this job to the
    // worker route now instead of waiting for the next cron tick. Fire-
    // and-forget: env-gated (no QSTASH_TOKEN → skipped), and any failure
    // leaves the row for the cron — the queue table is the delivery
    // guarantee, QStash is the latency optimisation. Dedup id is
    // DASH-ONLY (QStash 400s on colons — the QSTASH.2 lesson).
    try {
      await publishQueuePush({
        path: CONTACT_IMPORTS_WORKER_PATH,
        body: { id: batch.id },
        deduplicationId: `contact-import-${batch.id}`,
      })
    } catch {
      // publishQueuePush swallows its own errors; belt-and-braces only.
    }

    return NextResponse.json({
      success: true,
      data: {
        import_id: batch.id,
        async: true,
        // Estimate based on ~200 rows/min throughput as a rough
        // first guess. Tighten once we have real data.
        estimated_seconds: Math.max(60, Math.ceil(rows.length / 3)),
      },
    })
  }

  // Sync path — same as before but via the shared runner.
  let result
  try {
    result = await runImportCommit(db, {
      importId: batch.id,
      locationId: targetLocationId,
      mapping, rows,
      batchTag: batch_tag,
      resolutions,
    })
  } catch (e) {
    await db.from('contact_imports').update({
      status: 'failed',
      error_message: e?.message || String(e),
    }).eq('id', batch.id)
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }

  await db.from('contact_imports').update({
    created_count: result.counts.created,
    updated_count: result.counts.updated,
    skipped_count: result.counts.skipped,
    errored_count: result.counts.errored,
  }).eq('id', batch.id)

  return NextResponse.json({
    success: true,
    data: {
      import_id: batch.id,
      async: false,
      summary: {
        total: rows.length,
        ...result.counts,
      },
    },
  })
}
