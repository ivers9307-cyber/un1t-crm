// HR-CLASS-ALLOC.2 — the Glofox class booking roster. Pure mappers are exported
// + unit-tested; the IO (upsert / lookup / roster read) does the DB work.
// Mirrors the shape of class-occurrences.js.
//
// Glofox exposes no per-event attendee endpoint, so the roster is assembled
// from the per-member /2.0/bookings fetches applyMemberSync already does (daily
// sync + every BOOKING_* webhook). It drives both the booked-vs-presence tag on
// heart_rate_sessions and the coach-view live-class roster panel.

import { toMillis } from '@/lib/class-occurrences'
import { logWarn } from '@/lib/log'

/**
 * Pure: shape one Glofox Booking (per /2.0/bookings) into a class_bookings
 * upsert row. Returns null when it lacks the bits we need (booking id, event
 * id, or location). `ctx` carries the resolved contact linkage.
 *
 * @param {object} booking  a /2.0/bookings item ({ _id, event_id, event_name, time_start, status, attended })
 * @param {{ locationId: string, contactId?: string|null, glofoxMemberId?: string|null, memberName?: string|null }} ctx
 */
export function mapBookingToRosterRow(booking, ctx = {}) {
  if (!booking || !booking._id || !booking.event_id || !ctx.locationId) return null
  const startMs = toMillis(booking.time_start)
  return {
    location_id: ctx.locationId,
    glofox_event_id: String(booking.event_id),
    glofox_booking_id: String(booking._id),
    glofox_member_id: ctx.glofoxMemberId ?? null,
    contact_id: ctx.contactId ?? null,
    member_name: ctx.memberName ? String(ctx.memberName).slice(0, 200) : null,
    class_name: booking.event_name ? String(booking.event_name).slice(0, 200) : null,
    starts_at: startMs == null ? null : new Date(startMs).toISOString(),
    status: typeof booking.status === 'string' ? booking.status.toUpperCase() : null,
    attended: booking.attended === true,
    raw: booking,
    synced_at: new Date().toISOString(),
  }
}

/**
 * IO: upsert a member's bookings into the roster. Best-effort — returns
 * { upserted }, logs (never throws) on a DB error so a caller firing it as a
 * member-sync side-effect can't be broken by it.
 *
 * @param {object} db  service-role client
 * @param {{ locationId: string, contactId?: string|null, glofoxMemberId?: string|null, memberName?: string|null, bookings: object[] }} opts
 */
export async function upsertClassBookings(db, { locationId, contactId = null, glofoxMemberId = null, memberName = null, bookings } = {}) {
  if (!db || !locationId || !Array.isArray(bookings) || bookings.length === 0) return { upserted: 0 }
  const rows = []
  for (const b of bookings) {
    const row = mapBookingToRosterRow(b, { locationId, contactId, glofoxMemberId, memberName })
    if (row) rows.push(row)
  }
  if (rows.length === 0) return { upserted: 0 }
  const { error } = await db.from('class_bookings').upsert(rows, { onConflict: 'location_id,glofox_booking_id' })
  if (error) {
    logWarn('class-bookings', 'upsert failed', { locationId, error: error.message })
    return { upserted: 0, error: error.message }
  }
  return { upserted: rows.length }
}
