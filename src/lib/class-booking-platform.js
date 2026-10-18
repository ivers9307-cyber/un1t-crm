// UN1TBOOK.7 — the one predicate behind both guards on class_bookings.
//
// Decision 7 (2026-10-17, spec C §2): Hatch bookings are projected into
// class_bookings so the coach sees who is coming and the studio dashboard
// shows fill and no-shows, but the CRM never sends a class reminder, credits
// attendance or pushes a reward for a un1t.online studio (un1t.online sends
// its own). A row is actionable only when BOTH guards hold: the row says
// `glofox`, and its studio is not a un1t.online studio. Nothing here reads a
// capability, a setting, notification_config or an env flag: it is not a
// switch, so nothing can turn it on for un1t.online.

import { listLocationsByMembershipSource } from '@/lib/membership/source'

/**
 * UN1TBOOK.2 — the one class_bookings.source_platform the CRM ever messages
 * or rewards from. Every customer-messaging or attendance-crediting read of
 * class_bookings filters `.eq('source_platform', CRM_CLASS_MESSAGING_PLATFORM)`
 * (tests/class-bookings-readers-guard.test.js). `class-bookings.js`
 * re-exports it so existing imports keep working.
 */
export const CRM_CLASS_MESSAGING_PLATFORM = 'glofox'

/**
 * May the CRM remind, credit or reward from this class_bookings row? True only
 * when the row's source_platform is CRM_CLASS_MESSAGING_PLATFORM AND its
 * location is not a un1t.online studio. A row with no source_platform (a select
 * that forgot the column) is false. `un1tOnlineLocationIds` must be a Set: a
 * caller whose location read failed has to decide what that means (it has no
 * list to pass), so a missing or non-Set value throws rather than reading as
 * "no un1t.online studios".
 *
 * @param {{ source_platform?: string|null, location_id?: string|null }} row
 * @param {{ un1tOnlineLocationIds: Set<string> }} ctx
 * @returns {boolean}
 */
export function crmMayActOnClassBooking(row, { un1tOnlineLocationIds } = {}) {
  if (!(un1tOnlineLocationIds instanceof Set)) {
    throw new TypeError('crmMayActOnClassBooking: un1tOnlineLocationIds must be a Set')
  }
  return row?.source_platform === CRM_CLASS_MESSAGING_PLATFORM && !un1tOnlineLocationIds.has(row.location_id)
}

/**
 * The query half of the guard: narrow a class_bookings query to the rows the
 * CRM may act on. Returns the builder so a chain can continue.
 *
 * @param {{ eq: Function }} query a class_bookings select builder
 */
export function scopeToCrmActionable(query) {
  return query.eq('source_platform', CRM_CLASS_MESSAGING_PLATFORM)
}

/**
 * The un1t.online studios, read once per tick. A failed read is
 * `{ ids: null, error }`, never an empty Set: the caller decides what an
 * unreadable list means.
 *
 * @param {object} db service-role client
 * @returns {Promise<{ ids: Set<string>, error: null } | { ids: null, error: any }>}
 */
export async function readUn1tOnlineLocationIds(db) {
  const { ids, error } = await listLocationsByMembershipSource(db, 'un1t_online')
  if (error || !ids) return { ids: null, error: error ?? new Error('un1t_online locations unreadable') }
  return { ids: new Set(ids), error: null }
}
