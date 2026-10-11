// TZ.14 — useMemberZone(): the member's clock (D7 = A), for member screens.
//
// The member's home studio is the contacts row's location_id; its brand
// (useMemberBrand → /api/public/branding?location_id=) carries the studio's
// `timezone` since TZ.14, so the zone costs no read of its own. Until the
// brand lands, or when it cannot be read, the zone is the platform default
// (Europe/Dublin): exactly what every member screen used before TZ.14.
//
// useMemberZoneState() also says whether the brand is still loading, for the
// few screens that WRITE a zone-keyed flag (the month-wrapped "seen" key) and
// so must not act on the fallback zone of a member whose studio is elsewhere.

import { useMemberBrand } from './use-member-brand'
import { memberZoneFromBrand } from './member-zone'

/** @returns {{ zone: string, loading: boolean }} */
export function useMemberZoneState() {
  const brand = useMemberBrand()
  return { zone: memberZoneFromBrand(brand), loading: Boolean(brand.loading) }
}

/** @returns {string} the member's home studio's IANA zone */
export function useMemberZone() {
  return useMemberZoneState().zone
}
