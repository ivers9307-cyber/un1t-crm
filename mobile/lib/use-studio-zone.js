// TZ.14 — the hooks side of mobile/lib/studio-zone.js (D3 = A): which zone a
// STAFF screen reads a record in. Kept apart (the use-brand precedent) so the
// decisions stay a pure vitest module and this file is the only one that
// reaches the auth context.
//
//   useStudioZone()            → the active studio's zone (the roster's "today")
//   useLocationZoneResolver()  → (locationId) => zone, over /api/mobile/me's locations
//   useLocationZone(id)        → one record's studio zone
//
// Every location of /api/mobile/me carries `timezone` since TZ.14. A payload
// without it (an older server, or a cached /me from before TZ.14) resolves to
// the platform default, Europe/Dublin: the pre-TZ.14 answer.

import { useMemo } from 'react'
import { useAuth } from './auth-context'
import { locationZoneResolver, zoneOfLocationRow } from './studio-zone'

/** @returns {string} the active studio's IANA zone */
export function useStudioZone() {
  const { activeLocation } = useAuth()
  return zoneOfLocationRow(activeLocation)
}

/** @returns {(locationId?: string|null) => string} */
export function useLocationZoneResolver() {
  const { locations, activeLocation } = useAuth()
  return useMemo(() => locationZoneResolver({ locations, activeLocation }), [locations, activeLocation])
}

/** @param {string|null|undefined} locationId  @returns {string} */
export function useLocationZone(locationId) {
  return useLocationZoneResolver()(locationId)
}
