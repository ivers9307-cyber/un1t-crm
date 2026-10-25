// ROLESWEEP.1c — caller shapes the shared tables (role-sweep-callers.js) do
// not cover, for the contacts / people / back-office batch (TEST-ONLY; not
// collected: vitest collects *.test.js only).
//
//   • ownerCases()         — an OWNER-only gate judged at the target
//                            (roleCases' rows are phrased for tiers that
//                            include manager, so their "(main: …)" labels do
//                            not hold for owner-only routes).
//   • webOrMobileCases()   — routes that accept the WEB key OR the MOBILE
//                            toggle. The permissionCases callers only set the
//                            web bag, and owner's mobile defaults switch every
//                            channel on, so they would pass through the mobile
//                            half; these set BOTH bags explicitly.
//
// Every row: [label, caller, target, 'pass' | 'forbidden' | 'hidden'].
// "(main: …)" says what origin/main (+ C7a) answered; a row without it
// answered the same before ROLESWEEP.1c.

import { person, MASTER, OUTSIDER, ORG, LOC_A, LOC_B } from './role-sweep-callers.js'

const two = (roleA, roleB, active) => person({ [LOC_A]: { role: roleA }, [LOC_B]: { role: roleB } }, active)

/**
 * @param {{ outsider?: 'hidden'|'forbidden', outsiderMain?: string|null }} [opts]
 *   outsider     — what a non-member of B gets (the route's membership answer).
 *   outsiderMain — set when origin/main answered the outsider differently
 *                  (a route that had no membership check), e.g. 'pass'.
 */
export function ownerCases({ outsider = 'hidden', outsiderMain = null } = {}) {
  return [
    ['owner at A, staff at B, A active (main: pass)', two('owner', 'staff', LOC_A), LOC_B, 'forbidden'],
    ['owner at A, manager at B, A active (main: pass)', two('owner', 'manager', LOC_A), LOC_B, 'forbidden'],
    ['staff at A, owner at B, A active (main: forbidden)', two('staff', 'owner', LOC_A), LOC_B, 'pass'],
    ['manager at A, owner at B, A active (main: forbidden)', two('manager', 'owner', LOC_A), LOC_B, 'pass'],
    ['owner at A with B active, target A (main: forbidden)', two('owner', 'staff', LOC_B), LOC_A, 'pass'],
    ['manager at A and at B, A active', two('manager', 'manager', LOC_A), LOC_B, 'forbidden'],
    ['a master', MASTER, LOC_B, 'pass'],
    [outsiderMain ? `an owner who does not belong to B (main: ${outsiderMain})` : 'an owner who does not belong to B', OUTSIDER, LOC_B, outsider],
  ]
}

/**
 * Web-OR-mobile permission gate judged at the target. `keys` are switched
 * together (a route gated on "email OR whatsapp" passes on either, so a
 * refusal needs both off).
 * @param {string[]} keys
 */
export function webOrMobileCases(keys) {
  const flags = (on) => Object.fromEntries(keys.map((k) => [k, on]))
  const both = (on) => ({ ...flags(on), mobile: flags(on) })
  const mobileOnly = (on) => ({ ...flags(false), mobile: flags(on) })
  const owner = (permissions, features) => ({ role: 'owner', permissions, ...(features ? { features } : {}) })
  const label = keys.join(' + ')
  const masterOffAtA = {
    ...MASTER,
    locations: [
      { id: LOC_A, organization_id: ORG, active: true, features: flags(false) },
      { id: LOC_B, organization_id: ORG, active: true, features: {} },
    ],
    activeLocation: { id: LOC_A, organization_id: ORG, active: true, features: flags(false) },
  }
  return [
    [`${label} off for them at B (web and mobile), A active (main: pass)`,
      person({ [LOC_A]: owner(both(true)), [LOC_B]: owner(both(false)) }, LOC_A), LOC_B, 'forbidden'],
    [`only the mobile ${label} toggle on, at A; nothing at B, A active (main: pass)`,
      person({ [LOC_A]: owner(mobileOnly(true)), [LOC_B]: owner(both(false)) }, LOC_A), LOC_B, 'forbidden'],
    [`${label} off for them at A only (web and mobile), A active (main: forbidden)`,
      person({ [LOC_A]: owner(both(false)), [LOC_B]: owner(both(true)) }, LOC_A), LOC_B, 'pass'],
    [`only the mobile ${label} toggle on, at B; nothing at A, A active (main: forbidden)`,
      person({ [LOC_A]: owner(both(false)), [LOC_B]: owner(mobileOnly(true)) }, LOC_A), LOC_B, 'pass'],
    [`feature ${label} off at A's location, A active (main: forbidden)`,
      person({ [LOC_A]: owner(both(true), flags(false)), [LOC_B]: owner(both(true)) }, LOC_A), LOC_B, 'pass'],
    [`a master with feature ${label} off at the active location (main: forbidden)`, masterOffAtA, LOC_B, 'pass'],
    ['an owner who does not belong to B', OUTSIDER, LOC_B, 'hidden'],
  ]
}
