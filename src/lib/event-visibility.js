// W0.3 — `race_events.shared` used to mean "visible on EVERY tenant's staff
// list and public events page". It now means "visible across the owning
// organisation": a Hatch event flagged shared still shows at Stillorgan;
// another gym never sees it. The PostgREST .or() string is built here so the
// three listings cannot drift.
import { orgLocationIdsFor } from './inbound-contact-match'

/** Pure. @param {string} locationId @param {string[]} orgLocationIds (includes locationId) */
export function sharedEventsOrFilter(locationId, orgLocationIds) {
  const own = `location_id.eq.${locationId}`
  if (!Array.isArray(orgLocationIds) || orgLocationIds.length === 0) return own
  return `${own},and(shared.eq.true,location_id.in.(${orgLocationIds.join(',')}))`
}

/** Async: resolve the org scope then build the filter. Narrows to own location on error. */
export async function sharedEventsOrFilterFor(db, locationId) {
  const ids = await orgLocationIdsFor(db, locationId)
  return sharedEventsOrFilter(locationId, ids)
}
