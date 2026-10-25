// TRAINERSROLE.1 — mixed-role callers for the /api/locations/[id] lookup
// routes (glofox-trainers, glofox-memberships, unifi-users, unifi-doors).
// TEST-ONLY: imported by the route.test.js files beside those routes, never by
// a route. Not collected as a test itself (vitest collects *.test.js only).
//
// Each caller is shaped the way getCurrentUser() builds it: `role` is the role
// at the ACTIVE studio (resolveActiveLocationRole), `rolesByLocation` holds the
// per-studio roles, `locations` is every studio the caller belongs to, and
// `profileRole` is profiles.role (where mastership lives).

export const LOC_A = 'a0000000-0000-4000-8000-00000000000a'
export const LOC_B = 'b0000000-0000-4000-8000-00000000000b'

function member(rolesByLocation, activeId) {
  return {
    id: 'user-1',
    isMaster: false,
    profileRole: 'staff',
    locations: Object.keys(rolesByLocation).map((id) => ({ id })),
    rolesByLocation,
    activeLocation: { id: activeId },
    role: rolesByLocation[activeId],
  }
}

export const MANAGER_A_STAFF_B = member({ [LOC_A]: 'manager', [LOC_B]: 'staff' }, LOC_A)
export const MANAGER_A_STAFF_B_ACTIVE_B = member({ [LOC_A]: 'manager', [LOC_B]: 'staff' }, LOC_B)
export const STAFF_A_MANAGER_B = member({ [LOC_A]: 'staff', [LOC_B]: 'manager' }, LOC_A)
// Also what an org admin looks like at an org location they hold no explicit
// row at: expandOrgAdminAccess gives it a synthetic 'owner'.
export const STAFF_A_OWNER_B = member({ [LOC_A]: 'staff', [LOC_B]: 'owner' }, LOC_A)
export const STAFF_A_HEAD_COACH_B = member({ [LOC_A]: 'staff', [LOC_B]: 'head_coach' }, LOC_A)
export const OUTSIDER = member({ [LOC_A]: 'manager' }, LOC_A)
export const MASTER = {
  id: 'user-m',
  isMaster: true,
  profileRole: 'master',
  role: 'master',
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: {},
  activeLocation: { id: LOC_A },
}

// Review 3 callers.
// An inactive location: getCurrentUser gives a master every ACTIVE location
// only, so an inactive id is not in MASTER.locations (decision 7).
export const LOC_INACTIVE = 'c0000000-0000-4000-8000-00000000000c'
// In `locations` at B but with no rolesByLocation entry there (a membership
// with no role row). Manager at A, the ACTIVE studio, so on main the
// active-role check passed it.
export const MANAGER_A_NO_ROLE_B = { ...member({ [LOC_A]: 'manager' }, LOC_A), locations: [{ id: LOC_A }, { id: LOC_B }] }
// A master VIEWING AS the "staff at A, manager at B" person: getCurrentUser
// swaps in the target's profile (profileRole 'staff', their own locations
// and roles) and records the master only in impersonatingFrom. The gate must
// judge the target, never the master behind them.
export const MASTER_AS_STAFF_A_MANAGER_B = {
  ...STAFF_A_MANAGER_B,
  impersonatingFrom: { masterId: 'user-m', masterName: 'Master One', masterEmail: 'master.one@example.com' },
}

// [label (ends in the expected status), caller, target location, status,
//  error body or null]
// On origin/main before TRAINERSROLE.1, rows 1-4, 7, 8 and 9 give the wrong
// answer (1 → 200, 2-4 → 403, 7 → 403, 8 → 200, 9 → 200); rows 5, 6 and 10
// already hold.
export const ROLE_GATE_CASES = [
  ['a manager at A who is staff at B, asking for B (A active) → 403', MANAGER_A_STAFF_B, LOC_B, 403, 'forbidden'],
  ['a staff member at A who manages B, asking for B (A active) → 200', STAFF_A_MANAGER_B, LOC_B, 200, null],
  ['a manager at A with B active, asking for A → 200', MANAGER_A_STAFF_B_ACTIVE_B, LOC_A, 200, null],
  ['an owner at B (or an org admin) with A active, asking for B → 200', STAFF_A_OWNER_B, LOC_B, 200, null],
  ['a head coach at B, asking for B → 403', STAFF_A_HEAD_COACH_B, LOC_B, 403, 'forbidden'],
  ['a master → 200', MASTER, LOC_B, 200, null],
  ['a manager who does not belong to B, asking for B → 404', OUTSIDER, LOC_B, 404, 'Not found'],
  ['a master asking for an inactive location → 404', MASTER, LOC_INACTIVE, 404, 'Not found'],
  ['a member of B with no role row at B (manager at A, A active) → 403', MANAGER_A_NO_ROLE_B, LOC_B, 403, 'forbidden'],
  ['a master viewing as the staff-at-A/manager-at-B person, asking for A → 403', MASTER_AS_STAFF_A_MANAGER_B, LOC_A, 403, 'forbidden'],
]
