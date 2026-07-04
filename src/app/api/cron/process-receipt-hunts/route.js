// RCOV.P1 — background drainer for the receipt-hunt queue.
//
// seedHunts (statuses.js, run by receipt-coverage-weekly) queues every
// uncovered/not_found recon_bank_lines row by setting hunt_queued_at.
// IMAP search + Claude Vision scoring is slow and best run one line at
// a time, so we don't hunt in-request — this cron drains the queue
// sequentially, mirroring process-invoice-analysis's claim/drain shape.
//
// Each tick:
//   1. Atomically claim up to BATCH queued rows (claim_recon_hunt_batch,
//      FOR UPDATE SKIP LOCKED — overlapping ticks never grab the same row).
//   2. Hunt each sequentially via huntLine (never throws — always
//      resolves {outcome: 'found'|'not_found'|'error', ...}); tally by
//      outcome.
//   3. Once claimed rows are worked, ask the finalizer whether the
//      weekly cycle is done (hunt queue empty + this week's cron pull
//      exists + no report sent yet) — if so it compiles + emails
//      report v2 and stamps the WEEKLY heartbeat itself.
//   4. Stamp THIS cron's own liveness heartbeat every healthy tick —
//      distinct from the weekly heartbeat, which the finalizer owns
//      (see receipt-coverage-weekly/route.js's file-header comment).
//
// BATCH is small (hunts do IMAP round-trips + an LLM call per
// candidate) so a worst-case tick stays well under the 300s function cap.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { huntLine } from '@/lib/recon/hunt'
import { maybeFinalizeWeekly } from '@/lib/recon/finalize'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const BATCH = 3

export async function GET(request) {
  // Fail-closed: no secret configured → reject (SEC-P0.3 pattern).
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()

  const { data: claimed, error: claimErr } = await db.rpc('claim_recon_hunt_batch', { p_limit: BATCH })
  if (claimErr) {
    return NextResponse.json({ success: false, error: `claim: ${claimErr.message}` }, { status: 500 })
  }
  const rows = claimed || []

  let found = 0
  let notFound = 0
  let failed = 0

  for (const row of rows) {
    const res = await huntLine(db, row)
    if (res.outcome === 'found') found++
    else if (res.outcome === 'not_found') notFound++
    else failed++
  }

  const fin = await maybeFinalizeWeekly(db)

  // This cron's own liveness — the WEEKLY heartbeat belongs to the
  // finalizer (stamped only when the source cron run was clean AND the
  // report email sent).
  await stampHeartbeat('process-receipt-hunts').catch(() => {})

  return NextResponse.json({
    success: true,
    data: {
      claimed: rows.length,
      found,
      notFound,
      failed,
      finalized: fin.finalized,
      finalizeReason: fin.reason || null,
    },
  })
}
