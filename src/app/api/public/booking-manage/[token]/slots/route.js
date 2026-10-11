// GET /api/public/booking-manage/[token]/slots?date=YYYY-MM-DD — BOOKINGSELF.1
//
// Public, no session; the signed token is the credential (404 on any bad
// one). The free times on one date for the token holder's booking type,
// computed by the public widget's own machinery (computeAvailableSlots, the
// studio's zone) with the holder's own booking NOT counted as taken, so they
// can shift by less than its length. Only while the booking can still be
// rescheduled; otherwise the refusal the page shows. Times only: never a
// count or a capacity. Rate limited with the summary: 60 per IP per 5 min.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { computeAvailableSlots } from '@/lib/booking-slots'
import { bookingChangeState } from '@/lib/booking-self-service'
import { refusal, resolveManagedBooking } from '../_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const { token } = await props.params
  const date = new URL(request.url).searchParams.get('date')
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ success: false, error: 'bad_date', message: 'Pick a date.' }, { status: 400 })
  }
  const db = createServerClient()

  const limit = await checkRateLimit(db, `booking-manage:${getClientIp(request)}`, { max: 60, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const resolved = await resolveManagedBooking(db, token)
  if (resolved.response) return resolved.response
  const { booking, zone } = resolved

  const state = bookingChangeState({ booking, zone })
  if (!state.canReschedule) return refusal(state.code || 'not_changeable', { studioName: booking.event_types?.locations?.name })

  const slots = await computeAvailableSlots(db, booking.event_types, date, { zone, excludeBookingId: booking.id })
  return NextResponse.json({ success: true, data: { date, slots: slots.map((s) => ({ start: s.start, end: s.end })) } })
}
