// INCLUSION-CORE T4 — pure decision helpers for the credit-attendance cron.
//
// The cron (src/app/api/cron/credit-attendance/route.js) auto-credits a flat
// "participation" session to every member marked attended for a completed
// Glofox class who doesn't already have a session for that class. These pure
// helpers carry the idempotency decision (one credit per member per class) so
// it can be unit-tested without standing up Supabase.

/**
 * The idempotency key for a (member, class) pair. A member earns at most one
 * session per class, whether that session is an HR session (device user) or a
 * previously-credited participation session. The key is `${contactId}|${glofoxEventId}`.
 *
 * Returns null when either side is missing — such a booking can't be keyed and
 * must be skipped (the cron query already excludes contact_id IS NULL, this is
 * the belt-and-braces guard).
 *
 * @param {{ contact_id?: string|null, glofox_event_id?: string|null }} booking
 * @returns {string|null}
 */
export function dedupeKey(booking) {
  const contactId = booking?.contact_id
  const eventId = booking?.glofox_event_id
  if (!contactId || !eventId) return null
  return `${contactId}|${eventId}`
}

/**
 * Filter a page of attended bookings down to the ones that still need a
 * participation credit: those whose (contact, class) key is NOT already in
 * `existingKeys` (the set of keys that already have ANY session — HR or
 * participation). Bookings that can't be keyed (missing contact/event) are
 * dropped. Within the page, the first booking wins per key so two attended
 * rows for the same member+class don't both get credited.
 *
 * @param {Array<object>} bookings   a page of class_bookings rows
 * @param {Set<string>} existingKeys keys (`${contactId}|${eventId}`) already credited
 * @returns {Array<object>} the subset of bookings to credit
 */
export function filterUncredited(bookings, existingKeys) {
  const out = []
  const seenThisPage = new Set()
  for (const b of bookings || []) {
    const key = dedupeKey(b)
    if (!key) continue
    if (existingKeys && existingKeys.has(key)) continue
    if (seenThisPage.has(key)) continue
    seenThisPage.add(key)
    out.push(b)
  }
  return out
}
