// ROLESWEEP.1 — mixed-role callers and the expected-outcome tables for the
// estate-wide "judge the role at the TARGET location" sweep (TEST-ONLY).
//
// Same idea as src/app/api/locations/[id]/_role-gate-cases.js (TRAINERSROLE.1),
// widened: each caller also carries the per-location PERMISSION data
// getCurrentUser builds (assignmentsByLocation, roleTemplatesByLocation,
// locations[].features) and the ACTIVE-location mirrors hasPermission reads
// (activeLocation, activeAssignment, activeRoleTemplate), so one caller
// exercises both halves of the bug class:
//   • user.role        — the role at the ACTIVE studio;
//   • hasPermission()  — the permission at the ACTIVE studio.
// The target of every case is LOC_B unless the label says otherwise.
//
// Shapes mirror the real mixed-role population on 28 Sep 2026 (counts only,
// no names): a head coach at one studio who is staff at the other, an owner
// at one studio who is head coach at the other, a manager at both with
// overrides at one, and an owner at three studios whose features differ.

export const ORG = 'f0000000-0000-4000-8000-0000000000f0'
export const LOC_A = 'a0000000-0000-4000-8000-00000000000a'
export const LOC_B = 'b0000000-0000-4000-8000-00000000000b'
export const LOC_OTHER = 'd0000000-0000-4000-8000-00000000000d'

/**
 * @param {Record<string, { role: string, permissions?: object, features?: object, template?: object|null }>} byLoc
 * @param {string} activeId
 */
export function person(byLoc, activeId, extra = {}) {
  const ids = Object.keys(byLoc)
  const locations = ids.map((id) => ({ id, organization_id: ORG, active: true, name: `Studio ${id.slice(0, 1).toUpperCase()}`, features: byLoc[id].features || {} }))
  const rolesByLocation = Object.fromEntries(ids.map((id) => [id, byLoc[id].role]))
  const assignmentsByLocation = Object.fromEntries(ids.map((id) => [id, { role: byLoc[id].role, permissions: byLoc[id].permissions || {}, is_default: id === activeId }]))
  const roleTemplatesByLocation = Object.fromEntries(ids.map((id) => [id, byLoc[id].template || null]))
  return {
    id: 'user-1',
    email: 'coach.one@example.com',
    full_name: 'Coach One',
    isMaster: false,
    profileRole: 'staff',
    locations,
    rolesByLocation,
    assignmentsByLocation,
    roleTemplatesByLocation,
    organizationsById: { [ORG]: { id: ORG } },
    orgAdminOrgIds: [],
    activeLocation: locations.find((l) => l.id === activeId),
    activeAssignment: assignmentsByLocation[activeId] || null,
    activeRoleTemplate: roleTemplatesByLocation[activeId] || null,
    role: rolesByLocation[activeId],
    ...extra,
  }
}

// ── role-shaped callers (target LOC_B unless the label says A) ─────────────
// `grant` (a permission key) is switched ON for the caller at every studio, so
// a route that gates on role AND a permission is tested on the role alone here
// (permissionCases tests the key alone).
const g = (grant) => (grant ? { [grant]: true } : {})
const two = (roleA, roleB, active, grant) => person({ [LOC_A]: { role: roleA, permissions: g(grant) }, [LOC_B]: { role: roleB, permissions: g(grant) } }, active)
export const MANAGER_A_STAFF_B = two('manager', 'staff', LOC_A)
export const STAFF_A_MANAGER_B = two('staff', 'manager', LOC_A)
export const OUTSIDER = person({ [LOC_A]: { role: 'owner' } }, LOC_A)
export const MASTER = {
  ...person({}, LOC_A),
  id: 'user-m',
  email: 'master.one@example.com',
  full_name: 'Master One',
  isMaster: true,
  profileRole: 'master',
  role: 'master',
  locations: [LOC_A, LOC_B].map((id) => ({ id, organization_id: ORG, active: true, features: {} })),
  rolesByLocation: {},
  assignmentsByLocation: {},
  roleTemplatesByLocation: {},
  activeLocation: { id: LOC_A, organization_id: ORG, active: true, features: {} },
  activeAssignment: null,
  activeRoleTemplate: null,
}

// ── permission-shaped callers: OWNER at both studios (so any role floor a
// route also has is met), with the key set explicitly at each studio (so the
// code default for the key does not matter). Only the permission differs. ──
/** The key is ON for them at A (active) and switched OFF for them at B. */
export const keyOffAtB = (key) => person({ [LOC_A]: { role: 'owner', permissions: { [key]: true } }, [LOC_B]: { role: 'owner', permissions: { [key]: false } } }, LOC_A)
/** The key is OFF for them at A (active) and ON at B. */
export const keyOnAtBOnly = (key) => person({ [LOC_A]: { role: 'owner', permissions: { [key]: false } }, [LOC_B]: { role: 'owner', permissions: { [key]: true } } }, LOC_A)
/** The key is ON for them at both, but the FEATURE is off at A's location (the CCF Autos shape). */
export const featureOffAtA = (key) => person({ [LOC_A]: { role: 'owner', permissions: { [key]: true }, features: { [key]: false } }, [LOC_B]: { role: 'owner', permissions: { [key]: true } } }, LOC_A)
/** A master whose ACTIVE location has the feature off; the target (B) has it on. */
export const masterFeatureOffAtA = (key) => ({
  ...MASTER,
  locations: [{ id: LOC_A, organization_id: ORG, active: true, features: { [key]: false } }, { id: LOC_B, organization_id: ORG, active: true, features: {} }],
  activeLocation: { id: LOC_A, organization_id: ORG, active: true, features: { [key]: false } },
})
/** A master whose ACTIVE location (A) has the feature on; the TARGET (B) has it off. */
export const masterFeatureOffAtB = (key) => ({
  ...MASTER,
  locations: [{ id: LOC_A, organization_id: ORG, active: true, features: {} }, { id: LOC_B, organization_id: ORG, active: true, features: { [key]: false } }],
  activeLocation: { id: LOC_A, organization_id: ORG, active: true, features: {} },
})

/**
 * Expected-outcome table for a route whose gate is `roles` (+ optional
 * permission `key`) judged at the target. Each row:
 *   [label, caller, target, outcome]   outcome: 'pass' | 'forbidden' | 'hidden'
 * 'forbidden' = the route's role/permission refusal; 'hidden' = the route's
 * non-member refusal (404 on a detail row, 403 on a body/query location).
 * Rows marked (main: …) say what origin/main answered before ROLESWEEP.
 */
export function roleCases(roles, grant = null) {
  const has = (r) => roles.includes(r)
  const mainHc = has('head_coach') ? 'pass' : 'forbidden'
  return [
    ['manager at A, staff at B, A active (main: pass)', two('manager', 'staff', LOC_A, grant), LOC_B, 'forbidden'],
    ['staff at A, manager at B, A active (main: forbidden)', two('staff', 'manager', LOC_A, grant), LOC_B, 'pass'],
    ['manager at A with B active, target A (main: forbidden)', two('manager', 'staff', LOC_B, grant), LOC_A, 'pass'],
    ['staff at A, owner at B, A active (main: forbidden)', two('staff', 'owner', LOC_A, grant), LOC_B, 'pass'],
    [`head coach at A, staff at B, A active (main: ${mainHc})`, two('head_coach', 'staff', LOC_A, grant), LOC_B, 'forbidden'],
    ['owner at A, head coach at B, A active (main: pass)', two('owner', 'head_coach', LOC_A, grant), LOC_B, has('head_coach') ? 'pass' : 'forbidden'],
    ['staff at A, head coach at B, A active (main: forbidden)', two('staff', 'head_coach', LOC_A, grant), LOC_B, mainHc],
    ['a master', MASTER, LOC_B, 'pass'],
    ['an owner who does not belong to B', OUTSIDER, LOC_B, 'hidden'],
  ]
}

/** Expected-outcome table for a permission-key gate judged at the target. */
export function permissionCases(key) {
  return [
    [`${key} switched off for them at B, A active (main: pass)`, keyOffAtB(key), LOC_B, 'forbidden'],
    [`${key} switched off for them at A only, A active (main: forbidden)`, keyOnAtBOnly(key), LOC_B, 'pass'],
    [`feature ${key} off at A's location, A active (main: forbidden)`, featureOffAtA(key), LOC_B, 'pass'],
    [`a master with feature ${key} off at the active location (main: forbidden)`, masterFeatureOffAtA(key), LOC_B, 'pass'],
    ['an owner who does not belong to B', OUTSIDER, LOC_B, 'hidden'],
  ]
}
