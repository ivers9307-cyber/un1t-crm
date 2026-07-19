// Cron — drain the contact_imports queue (mig 096).
//
// Picks the oldest pending batch and runs it through the shared
// claim/process/stamp implementation in src/lib/contact-import-queue.js
// (runImportCommit against the stored payload, then completed/failed
// stamped on the row). One pass per cron tick — even at 50k rows / 60s
// the runner finishes well within the 5-minute Vercel maxDuration
// budget.
//
// QSTASH.4: this cron is now the SWEEPER, not the only consumer — the
// commit route's async path also publishes each queued job to QStash,
// whose worker (/api/webhooks/qstash/contact-imports) starts it within
// ~seconds via the same claim CAS. With QStash healthy this loop mostly
// finds no pending work; it remains the delivery guarantee for publish
// failures, QStash outages, and crashed runs (stuck-recovery below).
//
// Stuck-job recovery (CRON-ONLY — the QStash worker never does this):
// a row in 'processing' for >STUCK_AFTER_MINUTES is considered crashed
// (function timeout, deploy mid-run, etc.) and reset to 'pending' on
// the next pass, so the next worker run retries it. A second crash
// isn't auto-retried — operator picks it up via the import history
// page where the status reads 'failed' with the error_message.
//
// Auth: same bearer-token pattern as other crons — pg_cron sets
// the Authorization header to Bearer <CRON_SECRET>.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { claimAndProcessImportJob, STUCK_AFTER_MINUTES } from '@/lib/contact-import-queue'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 min — biggest 50k batch fits

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const stats = { processed: 0, recovered: 0, failed: 0, skipped: 0, skipped_no_work: 0 }

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

  // 2. Fetch the oldest pending job. The claim itself is the shared
  // CAS in src/lib/contact-import-queue.js — the QStash push consumer
  // races this pass by design (and pg_cron + manual pings could race
  // each other); exactly one claimant processes each job, everyone
  // else sees `skipped`.
  const { data: pending } = await db
    .from('contact_imports')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)

  const job = (pending || [])[0]
  if (!job) {
    stats.skipped_no_work = 1
    await stampHeartbeat('process-contact-imports', stats).catch(() => {})
    return NextResponse.json({ success: true, data: stats })
  }

  const outcome = await claimAndProcessImportJob(db, job)
  if (outcome.missingPayload) {
    // Shouldn't happen — fail loudly so we notice (row already
    // stamped 'failed' by the shared lib).
    stats.failed = 1
    return NextResponse.json({ success: false, error: 'Job missing payload', data: stats }, { status: 500 })
  }
  if (outcome.status === 'processed') {
    stats.processed = 1
  } else if (outcome.status === 'failed') {
    stats.failed = 1
  } else {
    stats.skipped = 1 // lost the claim race to the QStash worker
  }

  await stampHeartbeat('process-contact-imports', stats).catch(() => {})
  return NextResponse.json({ success: true, data: stats })
}
