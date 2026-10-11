// BOOKINGSELF.1 — what every /api/public/booking-manage/[token] route does
// first: verify the signed token (src/lib/booking-manage-tokens.js), read the
// booking it names, and resolve its studio zone. Any bad, expired or forged
// token, or a booking that no longer exists, is a 404 (never 401/403, so a
// link cannot be probed). A failed read or an unreadable zone is a 500.

import { NextResponse } from 'next/server'
import { verifyBookingManageTokenFromEnv } from '@/lib/booking-manage-tokens'
import {
  loadManagedBooking, managedBookingZone, bookingManageMessage, BOOKING_MANAGE_STATUS,
} from '@/lib/booking-self-service'
import { logWarn } from '@/lib/log'

/** A refusal: `error` (the code) and `message` (the customer sentence). */
export function refusal(code, ctx = {}) {
  return NextResponse.json(
    { success: false, error: code, message: bookingManageMessage(code, ctx) },
    { status: BOOKING_MANAGE_STATUS[code] || 400 },
  )
}

/**
 * @returns {Promise<{ response: Response } | { booking: object, zone: string }>}
 */
export async function resolveManagedBooking(db, token) {
  const claim = verifyBookingManageTokenFromEnv(token)
  if (!claim) return { response: refusal('not_found') }
  const { booking, error } = await loadManagedBooking(db, claim.bookingId)
  if (error) {
    logWarn('booking-manage', 'booking read failed', { err: error, bookingId: claim.bookingId })
    return { response: refusal('load_failed') }
  }
  if (!booking) return { response: refusal('not_found') }
  let zone
  try {
    zone = await managedBookingZone(db, booking)
  } catch (err) {
    // Never judge the 2-hour cut-off on a guessed clock.
    logWarn('booking-manage', 'studio zone unreadable', { err, bookingId: booking.id })
    return { response: refusal('load_failed') }
  }
  return { booking, zone }
}
