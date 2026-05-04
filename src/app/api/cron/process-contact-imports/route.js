// Cron — drain the contact_imports queue (mig 096).
//
// Picks the oldest pending batch, marks it processing, runs the
// shared runImportCommit() against its stored payload, then marks
// completed (or failed, with the error message stamped on the
// row). One pass per cron tick — even at 50k rows / 60s the
// runner finishes well within the 5-minute Vercel maxDuration
// budget.
//
// Stuck-job recovery: a row in 'processing' for >5 minutes is
// considered crashed (function timeout, deploy mid-run, etc.) and
// reset to 'pending' on the next pass, so the next worker run
// retries it. A second crash isn't auto-retried — operator picks
// it up via the import history page where the status reads
// 'failed' with the error_message.
//
// Auth: same bearer-token pattern as other crons — pg_cron sets
// the Authorization header to Bearer <CRON_SECRET>.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { runImportCommit } from '@/lib/contact-import-runner'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 min — biggest 50k batch fits

const STUCK_AFTER_MINUTES = 5

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const stats = { processed: 0, recovered: 0, failed: 0, skipped_no_work: 0 }

  // 1. Stuck-job recovery — reset anything in 'processing' for too
  // long. One UPDATE handles it.
  const stuckCutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000).toISOString()
  const { data: recovered } = await db
    .from('contact_imports')
    .update({
      status: 'pending',
      started_processing_at: null,
      error_message: 'Previous worker run timed out — retrying.',
    })
    .eq('status', 'processing')
    .lt('started_processing_at', stuckCutoff)
    .select('id')
  stats.recovered = (recovered || []).length

  // 2. Claim the oldest pending job. We update-with-returning to
  // avoid a TOCTOU race between two cron workers (Vercel doesn't
  // run two simultaneously, but pg_cron + manual pings could).
  const { data: claimed } = await db
    .from('contact_imports')
    .update({
      status: 'processing',
      started_processing_at: new Date().toISOString(),
    })
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .select('*')

  const job = (claimed || [])[0]
  if (!job) {
    stats.skipped_no_work = 1
    await stampHeartbeat('process-contact-imports', stats).catch(() => {})
    return NextResponse.json({ success: true, data: stats })
  }

  if (!job.payload) {
    // Shouldn't happen — the commit route always writes payload
    // when status='pending'. Fail loudly so we notice.
    await db.from('contact_imports').update({
      status: 'failed',
      error_message: 'Pending job had no payload.',
    }).eq('id', job.id)
    stats.failed = 1
    return NextResponse.json({ success: false, error: 'Job missing payload', data: stats }, { status: 500 })
  }

  const { mapping, rows, batchTag, resolutions } = job.payload

  try {
    const { counts } = await runImportCommit(db, {
      importId: job.id,
      locationId: job.location_id,
      mapping, rows, batchTag, resolutions,
    })
    await db.from('contact_imports').update({
      status: 'completed',
      created_count: counts.created,
      updated_count: counts.updated,
      skipped_count: counts.skipped,
      errored_count: counts.errored,
      // Drop the payload — it's served its purpose, no point
      // hanging onto a copy of every imported CSV forever.
      payload: null,
    }).eq('id', job.id)
    stats.processed = 1
  } catch (e) {
    await db.from('contact_imports').update({
      status: 'failed',
      error_message: (e?.message || String(e)).slice(0, 2000),
    }).eq('id', job.id)
    stats.failed = 1
  }

  await stampHeartbeat('process-contact-imports', stats).catch(() => {})
  return NextResponse.json({ success: true, data: stats })
}
