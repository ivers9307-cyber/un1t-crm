// GET /api/public/booking-manage/[token] — BOOKINGSELF.1
//
// Public, no session. The booking behind a signed booking-manage token (the
// {{manage_url}} link in the booking confirmation and reminder emails), for
// the /book/manage/[token] page. The token is the only credential: a bad,
// expired or forged one, or a booking that no longer exists, is a 404.
//
// Returns the public view (type name, studio name + address, date and time
// as stored in the studio's zone; never an email or a phone) plus:
//   can_cancel / can_reschedule  allowed now (confirmed, and more than two
//                                hours before the start on the studio's clock;
//                                reschedule also needs the type to be live)
//   blocked_reason               the sentence when nothing is allowed
//   reschedule_note              the sentence when only cancel is allowed
//   available_days               the days with a free slot of the same type
//                                (its own slot not counted as taken), when it
//                                can be rescheduled; null when that read failed
//
// Rate limited per IP: 60 per 5 minutes (bucket shared with /slots).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { bookingChangeState, publicBookingView, availableDaysForReschedule } from '@/lib/booking-self-service'
import { logWarn } from '@/lib/log'
import { resolveManagedBooking } from './_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const { token } = await props.params
  const db = createServerClient()

  const limit = await checkRateLimit(db, `booking-manage:${getClientIp(request)}`, { max: 60, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const resolved = await resolveManagedBooking(db, token)
  if (resolved.response) return resolved.response
  const { booking, zone } = resolved

  const state = bookingChangeState({ booking, zone })
  let availableDays = []
  if (state.canReschedule) {
    try {
      availableDays = await availableDaysForReschedule(db, booking, zone)
    } catch (err) {
      // The page says the dates could not be loaded; cancel still works.
      logWarn('booking-manage', 'available days unreadable', { err, bookingId: booking.id })
      availableDays = null
    }
  }

  return NextResponse.json({ success: true, data: publicBookingView(booking, state, { zone, availableDays }) })
}
