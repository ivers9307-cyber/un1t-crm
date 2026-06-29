// Drains class_booking_requests: claims queued rows, runs each through the
// decision-tree processor, stamps the heartbeat. Bounded batch per run.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { processClassBookingRequest } from '@/lib/class-booking-processor'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const db = createServerClient()
  const stats = { processed: 0, booked: 0, review: 0, failed: 0 }
  try {
    const { data: rows } = await db.from('class_booking_requests')
      .select('*').eq('status', 'queued').order('created_at', { ascending: true }).limit(25)
    for (const row of rows || []) {
      const { data: claimed } = await db.from('class_booking_requests')
        .update({ status: 'processing', attempts: (row.attempts || 0) + 1 })
        .eq('id', row.id).eq('status', 'queued').select('id').maybeSingle()
      if (!claimed) continue
      stats.processed++
      try {
        const r = await processClassBookingRequest(db, row)
        if (r.outcome === 'booked') stats.booked++
        else if (r.outcome === 'needs_review') stats.review++
        else stats.failed++
      } catch (e) {
        stats.failed++
        logWarn('process-class-bookings', `row ${row.id} threw`, { err: e })
        try { await db.from('class_booking_requests').update({ status: 'failed', last_error: String(e?.message || e) }).eq('id', row.id) } catch {}
      }
    }
    await stampHeartbeat('process-class-bookings', stats)
    return NextResponse.json({ success: true, ...stats })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}
