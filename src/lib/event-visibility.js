// W0.3 — `race_events.shared` used to mean "visible on EVERY tenant's staff
// list and public events page". It now means "visible across the owning
// organisation": a Hatch event flagged shared still shows at Stillorgan;
// another gym never sees it. The PostgREST .or() string is built here so the
// three listings cannot drift.
import { orgLocationIdsFor } from './inbound-contact-match'

// The string is a PostgREST filter DSL built by interpolation, so every id is
// shape-checked first: a bad locationId throws, a malformed org id is DROPPED
// (never interpolated).
const UUID_SHAPE = /^[0-9a-f-]{36}$/i

/** Pure. @param {string} locationId @param {string[]} orgLocationIds (includes locationId) */
export function sharedEventsOrFilter(locationId, orgLocationIds) {
  if (typeof locationId !== 'string' || !UUID_SHAPE.test(locationId)) {
    throw new Error('sharedEventsOrFilter: non-uuid location id')
  }
  const own = `location_id.eq.${locationId}`
  const ids = Array.isArray(orgLocationIds)
    ? orgLocationIds.filter((id) => typeof id === 'string' && UUID_SHAPE.test(id))
    : []
  if (ids.length === 0) return own
  return `${own},and(shared.eq.true,location_id.in.(${ids.join(',')}))`
}

/** Async: resolve the org scope then build the filter. Narrows to own location on error. */
export async function sharedEventsOrFilterFor(db, locationId) {
  const ids = await orgLocationIdsFor(db, locationId)
  return sharedEventsOrFilter(locationId, ids)
}
