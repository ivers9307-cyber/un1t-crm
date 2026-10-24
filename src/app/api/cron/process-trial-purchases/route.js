// PAIDTRIAL.1 — sweeper for trial_purchases (the class-bookings shape). Push
// delivery via QStash is the fast path; this cron is the delivery guarantee:
// it re-queues rows a dead run left in 'processing', claims anything QStash
// missed, and stamps the heartbeat. Bounded batch per run.
// TRIALSTUDIO.7 — then it settles the Hatch Street (un1t.online) rows off the
// un1t_transactions mirror and expires the abandoned ones. A sweep that could
// not read its rows skips the heartbeat (like the reaper); a per-row failure
// is counted in un1t_errors and does not.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { claimAndProcessTrialPurchase, MAX_ATTEMPTS } from '@/lib/trial-purchase-queue'
import { settleUn1tTrialPurchases } from '@/lib/trial-purchase-un1t-settle'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const STALE_MS = 10 * 60_000
const FRESH_ROW_GRACE_MS = 30_000

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const db = createServerClient()
  const stats = { reaped: 0, processed: 0, granted: 0, review: 0, failed: 0, reap_failed: 0, un1t_settled: 0, un1t_expired: 0, un1t_errors: 0, un1t_read_failed: 0 }
  try {
    const staleBefore = new Date(Date.now() - STALE_MS).toISOString()
    try {
      const { data: requeued, error: requeueErr } = await db.from('trial_purchases').update({ status: 'queued' })
        .eq('status', 'processing').lt('updated_at', staleBefore).lt('attempts', MAX_ATTEMPTS).select('id')
      if (requeueErr) { stats.reap_failed = 1; logError('process-trial-purchases', 'reaper requeue failed', { err: requeueErr }) }
      else stats.reaped = (requeued || []).length
      const { error: reviewErr } = await db.from('trial_purchases').update({ status: 'needs_review', last_error: 'max_attempts_stuck_processing' })
        .eq('status', 'processing').lt('updated_at', staleBefore).gte('attempts', MAX_ATTEMPTS)
      if (reviewErr) { stats.reap_failed = 1; logError('process-trial-purchases', 'reaper needs_review flag failed', { err: reviewErr }) }
    } catch (e) {
      stats.reap_failed = 1
      logError('process-trial-purchases', 'reaper threw', { err: e })
    }

    const { data: rows, error: rowsErr } = await db.from('trial_purchases')
      .select('*').eq('status', 'queued').lt('created_at', new Date(Date.now() - FRESH_ROW_GRACE_MS).toISOString())
      .order('created_at', { ascending: true }).limit(25)
    if (rowsErr) {
      logError('process-trial-purchases', 'queue read failed; nothing claimed, heartbeat not stamped', { err: rowsErr })
      return NextResponse.json({ success: false, error: 'Could not read the trial purchase queue', ...stats }, { status: 500 })
    }
    for (const row of rows || []) {
      const res = await claimAndProcessTrialPurchase(db, row)
      if (res.status === 'skipped') continue
      stats.processed++
      if (res.status === 'failed') { stats.failed++; logWarn('process-trial-purchases', `row ${row.id} threw`, { err: res.error }) }
      else if (res.outcome === 'granted') stats.granted++
      else if (res.outcome === 'needs_review') stats.review++
      else stats.failed++
    }
    try {
      const un1t = await settleUn1tTrialPurchases(db)
      stats.un1t_settled = un1t.settled
      stats.un1t_expired = un1t.expired
      stats.un1t_errors = un1t.errors
      if (un1t.readFailed) stats.un1t_read_failed = 1
    } catch (e) {
      // The sweeper never throws by contract; a bug here must not crash the run.
      stats.un1t_errors++
      logError('process-trial-purchases', 'un1t settle sweep threw', { err: e })
    }
    if (stats.reap_failed === 0 && stats.un1t_read_failed === 0) await stampHeartbeat('process-trial-purchases', stats)
    return NextResponse.json({ success: true, ...stats })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}
