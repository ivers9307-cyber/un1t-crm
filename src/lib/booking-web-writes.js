// C134 WEBBOOKINGWRITES.1 — the gate shared by the web booking writes
// (POST /api/bookings/[id]/status and /skip-reminder).
//
// /bookings and a booking type's page used to write `bookings` through the
// BROWSER client, so RLS judged the write, and the bookings write policies
// judge the PHONE `bookings` key. People who hold web Bookings without the
// phone toggle (5 memberships when this was found) saw their status and
// skip-reminder toggles do nothing, silently. The writes are service-role
// routes now, so the app decides: the WEB `bookings` key at the booking's
// studio (its own location_id, else its booking type's), after membership
// (404, ids are not enumerable). Server-only (auth.js).
import { NextResponse } from 'next/server'
import { assertLocationAccessOr404 } from './auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from './permissions'

const forbidden = () => NextResponse.json(
  { success: false, error: 'No bookings permission at this location' }, { status: 403 })
const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

/** The coarse pre-check, before any read: the web `bookings` key at SOME studio. */
export function bookingsWriteForbiddenAnywhere(user) {
  return hasPermissionAtAnyLocation(user, 'bookings') ? null : forbidden()
}

/**
 * Read the booking and decide. Returns { response } to send as-is, or
 * { booking, locationId } to act on.
 *
 * @param {object} db    createServerClient()
 * @param {object} user  getCurrentUser() result
 * @param {string} id    the booking id from the path
 */
export async function loadBookingForWebWrite(db, user, id) {
  const { data: booking, error } = await db.from('bookings')
    .select('id, status, location_id, event_types(location_id)')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    return { response: NextResponse.json({ success: false, error: 'Could not read the booking' }, { status: 500 }) }
  }
  const locationId = booking?.location_id || booking?.event_types?.location_id || null
  // No studio to judge at: refused like a missing row (fail closed).
  if (!booking || !locationId) return { response: notFound() }
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return { response: guard }
  if (!hasPermissionForLocation(user, locationId, 'bookings')) return { response: forbidden() }
  return { booking, locationId }
}
