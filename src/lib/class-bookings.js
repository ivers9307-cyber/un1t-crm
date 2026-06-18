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

// ── booked-vs-presence tag (HR-CLASS-ALLOC.2) ────────────────────

/**
 * Pure: the class_link_source stamp for a session. No live class → null (the
 * session isn't tied to a class). Live class → 'booked' if the member had a
 * booking for it, else 'presence'.
 *
 * @param {{ liveClass: object|null, booked: boolean }} args
 * @returns {'booked'|'presence'|null}
 */
export function resolveClassLinkSource({ liveClass, booked }) {
  if (!liveClass) return null
  return booked ? 'booked' : 'presence'
}

/**
 * IO: did this Glofox member have a non-cancelled booking for this event?
 * Returns false fast (no query) when any id is missing — anon walk-ins and
 * CRM-only contacts (no glofox_member_id) are never "booked".
 *
 * @param {object} db  service-role client
 * @param {{ locationId: string, glofoxEventId: string, glofoxMemberId: string|null }} opts
 */
export async function lookupBookedMember(db, { locationId, glofoxEventId, glofoxMemberId } = {}) {
  if (!db || !locationId || !glofoxEventId || !glofoxMemberId) return false
  const { data } = await db
    .from('class_bookings')
    .select('id')
    .eq('location_id', locationId)
    .eq('glofox_event_id', glofoxEventId)
    .eq('glofox_member_id', glofoxMemberId)
    .not('status', 'eq', 'CANCELLED')
    .limit(1)
  return Array.isArray(data) && data.length > 0
}

// ── live-class roster panel (HR-CLASS-ALLOC.2, PR3) ──────────────

/**
 * Pure: merge the class roster (class_bookings rows for the live occurrence)
 * with the open HR sessions into one tagged list for the coach panel. Match key
 * is glofox_member_id. Three kinds of entry result:
 *   - booked + HR (member booked AND wearing a strap)
 *   - booked + no HR (member booked, no strap)
 *   - walk-in (a session with no roster match): anon=true when it has no contact
 *
 * @param {Array<{glofox_member_id, member_name, status}>} roster
 * @param {Array<{id, contactId, glofoxMemberId, contactName, currentBpm, deviceIdentifier}>} sessions  (getLiveSessions shape)
 */
export function mergeRosterWithSessions(roster = [], sessions = []) {
  const byMember = new Map()
  for (const s of sessions) if (s.glofoxMemberId) byMember.set(String(s.glofoxMemberId), s)
  const usedSessionIds = new Set()
  const out = []
  for (const r of roster) {
    if (String(r.status || '').toUpperCase() === 'CANCELLED') continue
    const s = r.glofox_member_id ? byMember.get(String(r.glofox_member_id)) : null
    if (s) usedSessionIds.add(s.id)
    out.push({
      label: r.member_name || (s ? s.contactName : null) || '—',
      booked: true,
      hasHr: !!s,
      anon: false,
      currentBpm: s?.currentBpm ?? null,
      sessionId: s?.id ?? null,
    })
  }
  for (const s of sessions) {
    if (usedSessionIds.has(s.id)) continue
    out.push({
      label: s.contactName || s.deviceIdentifier || '—',
      booked: false,
      hasHr: true,
      anon: !s.contactId,
      currentBpm: s.currentBpm ?? null,
      sessionId: s.id,
    })
  }
  return out
}
