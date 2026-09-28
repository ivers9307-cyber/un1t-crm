// SWEEPER for class_booking_requests (QSTASH.7). Push delivery is the fast
// path: the enqueue sites publish { id } to QStash, which POSTs
// /api/webhooks/qstash/class-bookings — both consumers claim through the same
// CAS in src/lib/class-booking-queue.js, so they race safely. This cron
// remains the delivery guarantee: it re-queues rows orphaned in 'processing'
// by a dead run (CRON-ONLY reaper), claims + processes anything QStash missed
// (publish skipped/failed, retries exhausted), and stamps the heartbeat.
// Bounded batch per run.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { claimAndProcessBookingJob, MAX_ATTEMPTS } from '@/lib/class-booking-queue'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const STALE_MS = 10 * 60_000 // a row 'processing' longer than this lost its run (maxDuration is 5m)

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const db = createServerClient()
  const stats = { reaped: 0, processed: 0, booked: 0, review: 0, failed: 0, reap_failed: 0 }
  try {
    // Reaper: rows stuck in 'processing' (a prior run died mid-flight) would
    // otherwise be lost forever — the member may already be booked in Glofox.
    // Re-queue under the attempt cap; past it, flag for staff.
    const staleBefore = new Date(Date.now() - STALE_MS).toISOString()
    // CRONREADERR.1 — both reaper writes RESOLVE with { error } (a supabase
    // builder never throws), so the try/catch alone never saw a failure. Attempt
    // both, then judge: a failure leaves stuck rows for the next tick, is this
    // tick's own fault, and withholds the stamp (mig 644's 120 + 240 absorbs one
    // missed tick; a reaper broken on every tick pages). The queue still runs.
    try {
      const { data: requeued, error: requeueErr } = await db.from('class_booking_requests').update({ status: 'queued' })
        .eq('status', 'processing').lt('updated_at', staleBefore).lt('attempts', MAX_ATTEMPTS).select('id')
      if (requeueErr) {
        stats.reap_failed = 1
        logError('process-class-bookings', 'reaper requeue failed; stuck rows wait for the next tick', { err: requeueErr })
      } else {
        stats.reaped = (requeued || []).length
      }
      const { error: reviewErr } = await db.from('class_booking_requests').update({ status: 'needs_review', last_error: 'max_attempts_stuck_processing' })
        .eq('status', 'processing').lt('updated_at', staleBefore).gte('attempts', MAX_ATTEMPTS)
      if (reviewErr) {
        stats.reap_failed = 1
        logError('process-class-bookings', 'reaper needs_review flag failed; stuck rows wait for the next tick', { err: reviewErr })
      }
    } catch (e) {
      stats.reap_failed = 1
      logError('process-class-bookings', 'reaper threw', { err: e })
    }

    const { data: rows, error: rowsErr } = await db.from('class_booking_requests')
      .select('*').eq('status', 'queued').order('created_at', { ascending: true }).limit(25)
    if (rowsErr) {
      // A failed read is not "queue empty". Nothing is claimed; the rows stay
      // queued for the next tick and for the QStash worker.
      logError('process-class-bookings', 'queue read failed; nothing claimed, heartbeat not stamped', { err: rowsErr })
      return NextResponse.json({ success: false, error: 'Could not read the booking queue', ...stats }, { status: 500 })
    }
    for (const row of rows || []) {
      // Shared claim CAS + process + throw-path bookkeeping (QSTASH.7 —
      // src/lib/class-booking-queue.js, also run by the QStash worker).
      const res = await claimAndProcessBookingJob(db, row)
      if (res.status === 'skipped') continue // lost the race
      stats.processed++
      if (res.status === 'failed') {
        stats.failed++
        logWarn('process-class-bookings', `row ${row.id} threw`, { err: res.error })
      } else if (res.outcome === 'booked') stats.booked++
      else if (res.outcome === 'needs_review') stats.review++
      else stats.failed++
    }
    if (stats.reap_failed === 0) await stampHeartbeat('process-class-bookings', stats)
    return NextResponse.json({ success: true, ...stats })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}
