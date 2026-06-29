// Drains class_booking_requests: re-queues rows orphaned in 'processing' by a
// dead run, claims queued rows (CAS), runs each through the decision-tree
// processor, stamps the heartbeat. Bounded batch per run.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { processClassBookingRequest } from '@/lib/class-booking-processor'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MAX_ATTEMPTS = 3
const STALE_MS = 10 * 60_000 // a row 'processing' longer than this lost its run (maxDuration is 5m)

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const db = createServerClient()
  const stats = { reaped: 0, processed: 0, booked: 0, review: 0, failed: 0 }
  try {
    // Reaper: rows stuck in 'processing' (a prior run died mid-flight) would
    // otherwise be lost forever — the member may already be booked in Glofox.
    // Re-queue under the attempt cap; past it, flag for staff.
    const staleBefore = new Date(Date.now() - STALE_MS).toISOString()
    try {
      const { data: requeued } = await db.from('class_booking_requests').update({ status: 'queued' })
        .eq('status', 'processing').lt('updated_at', staleBefore).lt('attempts', MAX_ATTEMPTS).select('id')
      stats.reaped = (requeued || []).length
      await db.from('class_booking_requests').update({ status: 'needs_review', last_error: 'max_attempts_stuck_processing' })
        .eq('status', 'processing').lt('updated_at', staleBefore).gte('attempts', MAX_ATTEMPTS)
    } catch (e) { logWarn('process-class-bookings', 'reaper failed', { err: e }) }

    const { data: rows } = await db.from('class_booking_requests')
      .select('*').eq('status', 'queued').order('created_at', { ascending: true }).limit(25)
    for (const row of rows || []) {
      const { data: claimed } = await db.from('class_booking_requests')
        .update({ status: 'processing', attempts: (row.attempts || 0) + 1 })
        .eq('id', row.id).eq('status', 'queued').select('id').maybeSingle()
      if (!claimed) continue // lost the race
      stats.processed++
      try {
        const r = await processClassBookingRequest(db, row)
        if (r.outcome === 'booked') stats.booked++
        else if (r.outcome === 'needs_review') stats.review++
        else stats.failed++
      } catch (e) {
        stats.failed++
        logWarn('process-class-bookings', `row ${row.id} threw`, { err: e })
        // Retry under the cap, else flag for staff. The status guard stops this
        // ever clobbering a row the processor already moved to a terminal state.
        const next = (row.attempts || 0) + 1 >= MAX_ATTEMPTS ? 'needs_review' : 'queued'
        try { await db.from('class_booking_requests').update({ status: next, last_error: String(e?.message || e) }).eq('id', row.id).eq('status', 'processing') } catch {}
      }
    }
    await stampHeartbeat('process-class-bookings', stats)
    return NextResponse.json({ success: true, ...stats })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}
