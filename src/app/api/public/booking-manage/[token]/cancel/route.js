// POST /api/public/booking-manage/[token]/cancel — BOOKINGSELF.1
//
// Public, no session; the signed token is the credential (404 on any bad
// one, never 401/403). The person who booked cancels it: only a confirmed
// booking, only until two hours before its start on the studio's clock.
// The write is a compare-and-swap on status='confirmed' (a staff change in
// between answers `changed`). status -> 'cancelled' fires the
// booking_status_change_trigger, which writes the contact's timeline line
// (the way staff are told about public bookings at all). Nothing new is sent
// to the customer: the page is the confirmation. Body ignored.
// Rate limited per IP: 10 per 15 minutes (bucket shared with reschedule).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { bookingChangeState, cancelBookingByCustomer } from '@/lib/booking-self-service'
import { refusal, resolveManagedBooking } from '../_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, props) {
  const { token } = await props.params
  const db = createServerClient()

  const limit = await checkRateLimit(db, `booking-manage-write:${getClientIp(request)}`, { max: 10, windowMs: 15 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const resolved = await resolveManagedBooking(db, token)
  if (resolved.response) return resolved.response
  const { booking, zone } = resolved
  const studioName = booking.event_types?.locations?.name || null

  const state = bookingChangeState({ booking, zone })
  if (!state.canCancel) return refusal(state.code || 'not_changeable', { studioName })

  const done = await cancelBookingByCustomer(db, { booking })
  if (!done.ok) return refusal(done.code, { studioName })
  return NextResponse.json({ success: true, data: { cancelled: true, status: 'cancelled' } })
}
