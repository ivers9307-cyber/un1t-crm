// POST /api/public/booking-manage/[token]/reschedule — BOOKINGSELF.1
//
// Public, no session; the signed token is the credential (404 on any bad
// one, never 401/403). The person who booked moves it to another slot of the
// SAME booking type. Body { booking_date: 'YYYY-MM-DD', start_time: 'HH:MM' }
// (studio wall clock); anything else is ignored, never an end time or a type.
//
// Only a confirmed booking, only until two hours before its CURRENT start
// (studio clock), only while the type is live. The new slot is re-judged by
// findBookableSlot, the same check /api/public/book runs (availability
// window, duration + buffer grid, max_advance_days, the studio's today,
// blocked times, every other booking; this booking's own slot free), failing
// closed on an unreadable read. The write is a compare-and-swap on the row as
// read. Then: the booking's reminder sends are cleared so reminders fire
// again for the new time, a timeline line goes on the contact, and the type's
// own confirmation is sent again (operator channels and copy).
//
// Refusals carry `error` + `message`: 404 bad link / gone; 409 cancelled,
// too late, type not live, slot taken, changed meanwhile; 400 same time or a
// bad body; 500 a failed read or write. Rate limited per IP: 10 per 15
// minutes (bucket shared with cancel).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { bookingChangeState, rescheduleBookingByCustomer } from '@/lib/booking-self-service'
import { refusal, resolveManagedBooking } from '../_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const PublicBookingRescheduleSchema = z.object({
  booking_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM'),
})

export async function POST(request, props) {
  const { token } = await props.params
  const db = createServerClient()

  const limit = await checkRateLimit(db, `booking-manage-write:${getClientIp(request)}`, { max: 10, windowMs: 15 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const resolved = await resolveManagedBooking(db, token)
  if (resolved.response) return resolved.response
  const { booking, zone } = resolved
  const studioName = booking.event_types?.locations?.name || null

  const validation = await validateBody(request, PublicBookingRescheduleSchema)
  if (!validation.ok) return validation.response

  const state = bookingChangeState({ booking, zone })
  if (!state.canReschedule) return refusal(state.code || 'not_changeable', { studioName })

  const moved = await rescheduleBookingByCustomer(db, {
    booking, date: validation.data.booking_date, startTime: validation.data.start_time, zone,
  })
  if (!moved.ok) return refusal(moved.code, { studioName })

  const sent = Array.isArray(moved.confirmation?.sent) ? moved.confirmation.sent : []
  return NextResponse.json({
    success: true,
    data: { rescheduled: true, booking: moved.booking, confirmation_sent: sent.length > 0 },
  })
}
