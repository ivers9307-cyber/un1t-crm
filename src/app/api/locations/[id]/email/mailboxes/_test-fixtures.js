// Shared world for the mailbox-admin route tests.
//
// THE CAST IS THE POINT. Every fixture set carries a MANAGER at the location
// alongside the owner, because the hole this feature could open is a manager
// granting themselves `accounts@`: a manager holds the `email_inbox`
// permission, sees the inbox, and is NOT elevated. If the gate were ever
// loosened from master/owner to the surface permission, every "manager is
// refused" test here fails instead of a coach quietly gaining the studio's
// billing correspondence.
//
// It also carries an owner of a DIFFERENT studio, because "owner" is not a
// global role — owner-at-Hatch has no business editing Stillorgan's accounts.
//
// Reuses the ticket fixtures' ids so a test can hand a mailbox created here
// to the read path (visibleMailboxes) without re-deriving anything.

export {
  LOC_A, LOC_B, MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION,
} from '@/app/api/email/tickets/_test-fixtures'

import { LOC_A, LOC_B, MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION } from '@/app/api/email/tickets/_test-fixtures'

// assertLocationAccess reads user.locations; guardMasterOrOwner reads
// user.profileRole + user.rolesByLocation[locationId].
export const OWNER_A = {
  id: '0e11e100-0000-4000-8000-00000000000a', email: 'olive@un1tdublin.com', full_name: 'Olive Owner',
  role: 'owner', profileRole: 'owner',
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'owner' },
}
/** Owner at Hatch, nothing at Stillorgan — must be refused at LOC_A. */
export const OWNER_B = {
  id: '0e11e100-0000-4000-8000-00000000000b', email: 'oscar@hatchstreetfitness.com', full_name: 'Oscar Owner',
  role: 'owner', profileRole: 'owner',
  locations: [{ id: LOC_B }], rolesByLocation: { [LOC_B]: 'owner' },
}
/** Holds email_inbox at LOC_A. Not elevated. Must never manage or grant. */
export const MANAGER_A = {
  id: '00a11a6e-0000-4000-8000-00000000000c', email: 'mo@un1tdublin.com', full_name: 'Mo Manager',
  role: 'manager', profileRole: 'manager',
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' },
}
export const MASTER = {
  id: 'a5000000-0000-4000-8000-00000000000d', email: 'master@un1t.ie', full_name: 'Mx Master',
  role: 'master', profileRole: 'master',
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
}
export const COACH_A = {
  id: 'c0ac0000-0000-4000-8000-00000000000e', email: 'ada@un1tdublin.com', full_name: 'Ada Coach',
  role: 'staff', profileRole: 'staff',
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'staff' },
}

/** profiles rows for the same people (profiles.role is the ESTATE role). */
export const PROFILES = [
  { id: OWNER_A.id, full_name: OWNER_A.full_name, email: OWNER_A.email, role: 'owner', active: true },
  { id: MANAGER_A.id, full_name: MANAGER_A.full_name, email: MANAGER_A.email, role: 'manager', active: true },
  { id: COACH_A.id, full_name: COACH_A.full_name, email: COACH_A.email, role: 'staff', active: true },
  { id: MASTER.id, full_name: MASTER.full_name, email: MASTER.email, role: 'master', active: true },
  { id: OWNER_B.id, full_name: OWNER_B.full_name, email: OWNER_B.email, role: 'owner', active: true },
]

/** profile_locations rows — the per-location role. */
export const PROFILE_LOCATIONS = [
  { profile_id: OWNER_A.id, location_id: LOC_A, role: 'owner' },
  { profile_id: MANAGER_A.id, location_id: LOC_A, role: 'manager' },
  { profile_id: COACH_A.id, location_id: LOC_A, role: 'staff' },
  { profile_id: OWNER_B.id, location_id: LOC_B, role: 'owner' },
]

/**
 * Two live accounts at LOC_A plus one at LOC_B, the roster, and no grants —
 * the standard world. `extra` overrides any slice.
 */
export function adminState(extra = {}) {
  return {
    mailboxes: [{ ...MB_STUDIO }, { ...MB_ACCOUNTS }, { ...MB_OTHER_LOCATION }],
    grants: [],
    profiles: PROFILES.map(p => ({ ...p })),
    profileLocations: PROFILE_LOCATIONS.map(p => ({ ...p })),
    locations: [
      { id: LOC_A, name: 'UN1T Stillorgan' },
      { id: LOC_B, name: 'UN1T Hatch Street' },
    ],
    ...extra,
  }
}
