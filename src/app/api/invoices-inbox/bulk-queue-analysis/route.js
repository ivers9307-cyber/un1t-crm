// INV-BULK.1 — "Send for analysis" (bulk enqueue).
//
// Bookkeeper-gated. Takes an array of queue row ids and marks them for
// background analysis by the process-invoice-analysis cron. This is the
// instant, no-timeout counterpart to the synchronous bulk-analyse route:
// it just flags rows, so it scales to 100s.
//
// Per row:
//   • received          → quality_approved + analysis_queued_at (the
//                          operator's deliberate selection IS the quality
//                          decision for these — the 'received' gate exists
//                          to screen unsolicited supplier email, not files
//                          the operator chose to analyse).
//   • quality_approved  → analysis_queued_at (clear any prior error so the
//                          cron retries cleanly).
//   • extracted/data_approved/forwarded/rejected → skipped (already past
//                          analysis, or terminal).
//
// QSTASH.6: after the row updates land, each successfully-queued id is
// fire-and-forget published onto the QStash `invoice-analysis` QUEUE
// (parallelism 2 — Claude Vision OCR must stay rate-limit-bounded, so a
// 50-invoice bulk queue must never become 50 concurrent worker
// invocations). Publishes are batched with allSettled AFTER the loop
// (one 3s worst-case window total, not one per row), dedup id DASH-ONLY
// (QStash 400s on colons — the QSTASH.2 lesson), own try/catch — a
// publish failure never changes the operator's response; the
// process-invoice-analysis cron sweeps whatever QStash misses. This
// route is the ONLY site that sets analysis_queued_at (repo-sweep
// verified: bulk-analyse and the cron only ever clear it).
//
// Returns per-id outcomes + counts, same shape as the other bulk routes.

import { NextResponse } from 'next/server'
import {
  BulkIdsSchema,
  loadBookkeeper,
  loadAndScopeBulkRows,
} from '../_bulk-helpers'
import { validateBody } from '@/lib/validate'
import {
  publishQueuePush,
  INVOICE_ANALYSIS_WORKER_PATH,
  INVOICE_ANALYSIS_QUEUE_NAME,
  INVOICE_ANALYSIS_QUEUE_PARALLELISM,
} from '@/lib/qstash'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QUEUEABLE = new Set(['received', 'quality_approved'])

export async function POST(request) {
  const ctx = await loadBookkeeper()
  if (ctx.response) return ctx.response
  const { user, db } = ctx

  const validation = await validateBody(request, BulkIdsSchema)
  if (!validation.ok) return validation.response
  const { ids } = validation.data

  let scoped
  try {
    scoped = await loadAndScopeBulkRows({
      db, user, ids,
      select: 'id, location_id, status, attachment_path',
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
  const { rowsById, missingIds, forbiddenIds } = scoped

  const results = []
  for (const id of missingIds) results.push({ id, outcome: 'skipped', reason: 'not_found' })
  for (const id of forbiddenIds) results.push({ id, outcome: 'skipped', reason: 'forbidden' })

  const now = new Date().toISOString()
  for (const id of ids) {
    const row = rowsById[id]
    if (!row) continue
    if (!QUEUEABLE.has(row.status)) {
      results.push({ id, outcome: 'skipped', reason: `wrong_status:${row.status}` })
      continue
    }
    if (!row.attachment_path) {
      results.push({ id, outcome: 'skipped', reason: 'no_attachment' })
      continue
    }
    // received rows are auto-quality-approved (operator-vouched); already-
    // approved rows just get (re)queued with any stale error cleared.
    const { error: updErr } = await db
      .from('invoices_queue')
      .update({
        status: 'quality_approved',
        quality_reviewed_at: row.status === 'received' ? now : undefined,
        quality_reviewed_by: row.status === 'received' ? user.id : undefined,
        analysis_queued_at: now,
        analysis_claimed_at: null,
        extraction_error: null,
      })
      .eq('id', id)
      .in('status', ['received', 'quality_approved'])
    if (updErr) {
      results.push({ id, outcome: 'failed', error: updErr.message })
      continue
    }
    results.push({ id, outcome: 'queued' })
  }

  // Fire-and-forget QStash enqueue for every row that actually queued.
  // The table write above is the delivery guarantee (cron sweeps); the
  // push is the latency optimisation. allSettled + never-throwing
  // publishQueuePush + belt-and-braces try/catch: nothing here can
  // touch the operator's response.
  const queuedIds = results.filter((r) => r.outcome === 'queued').map((r) => r.id)
  if (queuedIds.length > 0) {
    try {
      await Promise.allSettled(queuedIds.map((id) => publishQueuePush({
        path: INVOICE_ANALYSIS_WORKER_PATH,
        body: { id },
        // Dash-separated, not colon — QStash 400s on colons in this
        // header (the QSTASH.2 lesson).
        deduplicationId: `invoice-analysis-${id}`,
        queueName: INVOICE_ANALYSIS_QUEUE_NAME,
        queueParallelism: INVOICE_ANALYSIS_QUEUE_PARALLELISM,
      })))
    } catch {
      // publishQueuePush swallows its own errors; belt-and-braces only.
    }
  }

  const counts = results.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] || 0) + 1
    return acc
  }, {})

  return NextResponse.json({ success: true, data: { results, counts } })
}
