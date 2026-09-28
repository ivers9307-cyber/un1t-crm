// ROLESWEEP.1 — the token scan behind two source guards:
//   • src/app/api/locations/[id]/role-at-path.test.js (TRAINERSROLE.1): no
//     route under /api/locations/[id] gates on the ACTIVE studio's role;
//   • tests/role-at-target.test.js (ROLESWEEP.1): no route anywhere under
//     /api both gates on the ACTIVE studio's role AND acts on a location
//     that can be another one; and no such route stops at the coarse
//     "any location" pre-check without judging the target (preCheckOnly).
//
// `user.role` is the caller's role at their ACTIVE studio
// (resolveActiveLocationRole in src/lib/auth.js), and hasPermission(user, …)
// resolves against the ACTIVE location's features, the active assignment's
// overrides and the active role template. A gate written on either judges the
// wrong studio whenever the route acts on a location from a row, the body,
// the query or "every location the caller belongs to" (the SCHEDROLES.1
// class). Judge at the target instead: hasRoleAtLocation(user, loc, ROLES),
// hasPermissionForLocation(user, loc, key), guardMasterOrOwner(user, loc),
// user.rolesByLocation[loc]; a coarse "any role anywhere" pre-check is
// hasRoleAtAnyLocation(user, ROLES).
//
// A floor, not a proof. BLIND SPOTS (a reviewer's job): the role copied into
// a variable first, a destructured or renamed user, a role read inside a
// helper (canAdminChallenges, a local isOwnerOrMaster(user) that reads
// user.role is caught only because it reads `user.role` in the same file),
// a client component's gate, and a `//` inside a regex literal on the same
// line as a gate (stripComments has no regex-literal awareness, so the rest
// of that line vanishes: a SILENT PASS for a forbidden-token scan).

import { stripComments } from './strip-comments.mjs'

// `user.role` or `user?.role`, and not `user.rolesByLocation` (the \b).
const USER_ROLE = String.raw`\buser\??\.role\b`
const NON_MASTER = String.raw`['"](?:owner|manager|head_coach|reception|staff)['"]`
const EQ = String.raw`\s*[!=]==?\s*`

export const ACTIVE_ROLE_GATE_PATTERNS = Object.freeze([
  new RegExp(String.raw`\.(?:includes|has)\(\s*${USER_ROLE}\s*\)`, 'g'), // ROLES.includes(user.role)
  new RegExp(`${USER_ROLE}${EQ}${NON_MASTER}`, 'g'), //                     user.role === 'owner'
  new RegExp(`${NON_MASTER}${EQ}${USER_ROLE}`, 'g'), //                     'owner' === user.role
  new RegExp(String.raw`\bswitch\s*\(\s*${USER_ROLE}\s*\)`, 'g'), //     switch (user.role)
  // hasPermission() resolves at the ACTIVE location; hasPermissionForLocation
  // (user, id, key) is the per-location form, kept out by the \( right after
  // the name.
  /\bhasPermission\(\s*user\s*,/g,
  // hasMobilePermission() resolves at the ACTIVE location too (user.role,
  // user.activeLocation, the active assignment's mobile overrides, the active
  // role template; src/lib/permissions.js). A `hasPermission ||
  // hasMobilePermission` gate is only fixed when BOTH halves judge the target.
  /\bhasMobilePermission\(\s*user\s*,/g,
])

// Signs that a route acts on a location OTHER than the active one: a
// membership check on anything but user.activeLocation, or the caller's
// whole location list.
export const OTHER_LOCATION_PATTERNS = Object.freeze([
  /\bassertLocationAccess(?:Or404)?\(\s*user\s*,\s*(?!user\??\.activeLocation\b)[^)\s]/g,
  /\bgetUserLocationIds\(\s*user\s*\)/g,
  /\buser\??\.locations\b/g,
])

// The coarse "holds it somewhere" pre-checks. Never the decision on their own.
export const ANY_LOCATION_PRECHECK_PATTERNS = Object.freeze([
  /\bhasRoleAtAnyLocation\(/g,
  /\bhasPermissionAtAnyLocation\(/g,
  /\bhasMobilePermissionAtAnyLocation\(/g, // ROLESWEEP.1c — the mobile twin
])

// The decision at the target location. A call in the same file counts, so a
// local helper (a `loadOwned` that calls hasRoleAtLocation) is seen through;
// a helper in another module is not, and its route goes on the guard's
// allowlist with the reason.
export const TARGET_JUDGEMENT_PATTERNS = Object.freeze([
  /\bhasRoleAtLocation\(/g,
  /\bhasPermissionForLocation\(/g,
  /\bguardMasterOrOwner\(/g,
  /\bhasMobilePermissionForLocation\(/g, // ROLESWEEP.1c — the mobile twin
])

const hits = (code, patterns) => patterns.flatMap((re) => [...code.matchAll(re)].map((m) => m[0]))

/** Every active-studio role/permission gate token in `source` (comments ignored). */
export function activeRoleGates(source) {
  return hits(stripComments(source), ACTIVE_ROLE_GATE_PATTERNS)
}

/** Every "acts on another location" token in `source` (comments ignored). */
export function otherLocationUses(source) {
  return hits(stripComments(source), OTHER_LOCATION_PATTERNS)
}

/** Every coarse any-location pre-check call in `source` (comments ignored). */
export function anyLocationPreChecks(source) {
  return hits(stripComments(source), ANY_LOCATION_PRECHECK_PATTERNS)
}

/** Every at-the-target role/permission decision call in `source` (comments ignored). */
export function targetJudgements(source) {
  return hits(stripComments(source), TARGET_JUDGEMENT_PATTERNS)
}

/**
 * The pre-check-only shape: a coarse any-location pre-check, a sign the
 * route acts on another location, and NO decision at the target in the file.
 * "Holds the role somewhere" plus "is a member there" admits a head coach at
 * one studio to act as one at a studio where they are staff.
 */
export function preCheckOnly(source) {
  return anyLocationPreChecks(source).length > 0
    && otherLocationUses(source).length > 0
    && targetJudgements(source).length === 0
}
