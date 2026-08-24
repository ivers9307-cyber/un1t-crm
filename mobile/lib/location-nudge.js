// mobile/lib/location-nudge.js
//
// LOC-NUDGE.1 — pure decision for Home's "enable location" card. NO native
// imports — vitest runs this in Node. Storage (the sticky dismissal) and the
// permission prompt live in the component; this module only answers "is
// location permission the thing standing between this user and the on-site
// Home?".
//
// Deliberately narrow: it never fires when permission is granted (being
// offsite is a fact, not a fault), never over an unreadable permission (the
// geofence-permission.js rule — an API fault is not a user choice), never on
// a kiosk (a shared studio iPad can't meaningfully grant), and never for a
// user with no on-site tiles anywhere (nothing to unlock).

import { homeTiles } from './home-logic'

/**
 * @param {object} args
 * @param {'loading'|'at_studio'|'offsite'|'unknown'} args.physStatus
 * @param {'granted'|'ask'|'settings'|'unknown'} args.foregroundPermission
 * @param {boolean} args.dismissed   sticky per-device "Not now"
 * @param {boolean} args.onSiteFeatures  from hasOnSiteFeatures()
 * @param {boolean} args.isKiosk
 * @param {boolean} args.hasRegions  at least one studio has a configured
 *   geofence — without one, granting could not deliver the on-site Home,
 *   so permission is NOT the actual blocker and the card must not promise it
 */
export function shouldShowLocationNudge({
  physStatus,
  foregroundPermission,
  dismissed,
  onSiteFeatures,
  isKiosk,
  hasRegions,
}) {
  if (physStatus !== 'offsite' && physStatus !== 'unknown') return false
  if (foregroundPermission !== 'ask' && foregroundPermission !== 'settings') return false
  if (dismissed || isKiosk || !onSiteFeatures || !hasRegions) return false
  return true
}

/** Does ANY assigned location give this user at least one on-site tile? */
export function hasOnSiteFeatures(profile, locations) {
  if (!profile) return false
  return (locations || []).some((l) => homeTiles(profile, l).length > 0)
}
