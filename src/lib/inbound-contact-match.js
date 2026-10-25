// W0.2 — the ORGANISATION scope for matching an inbound sender (WhatsApp
// phone, mail From) to an existing contact. Before this, both webhooks
// matched across the whole estate with a location *preference*, so a person
// who was already a contact at tenant A and wrote to tenant B's number or
// mailbox was linked to A's row — and the WhatsApp thread was then FILED at
// A. Never wider than the receiving location's organisation; on a sibling
// lookup error, narrow to the receiving location (fail safe, never open).
import { siblingLocationIds } from './sibling-locations'

// A `.in('location_id', [])` is an empty filter in PostgREST, not "nothing",
// so an empty scope is pinned to an id no row carries.
export const NO_SCOPE_SENTINEL = '00000000-0000-0000-0000-000000000000'

/** The `.in('location_id', …)` argument for a scope: never an empty list. */
export function scopeFor(ids) {
  return ids.length ? ids : [NO_SCOPE_SENTINEL]
}

/**
 * @param {object} db service-role client
 * @param {string|null} receivingLocationId the location owning the number / mailbox
 * @returns {Promise<string[]>} location ids a contact match may come from
 */
export async function orgLocationIdsFor(db, receivingLocationId) {
  if (!receivingLocationId) return []
  const { ids } = await siblingLocationIds(db, receivingLocationId)
  return [receivingLocationId, ...ids]
}
