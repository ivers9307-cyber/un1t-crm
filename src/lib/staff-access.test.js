// Tests for the three audit fixes:
//   1. mapProfileLocationToAssignment preserves the permissions blob
//      (regression — bug was on the SELECT side, but the helper
//      now centralises the contract so the bug can't recur silently).
//   2. canEditStaffMember enforces the new owner-self / owner-peer
//      restrictions.
//   3. canEditLocationFeatures restricts feature toggles to master.

import { describe, it, expect } from 'vitest'
import {
  mapProfileLocationToAssignment,
  canEditStaffMember,
  canOverrideStaffPassword,
  canEditLocationFeatures,
} from './staff-access.js'

describe('mapProfileLocationToAssignment — surfaces UNIFI-DOORS-SCOPE fields', () => {
  it('passes unifi_door_ids through as-is when present', () => {
    const pl = {
      location_id: 'loc-A',
      role: 'staff',
      unifi_door_ids: ['door-main', 'door-physio'],
      permissions: {},
    }
    const a = mapProfileLocationToAssignment(pl)
    expect(a.unifi_door_ids).toEqual(['door-main', 'door-physio'])
  })

  it('passes empty array through (means "no doors visible")', () => {
    const pl = { location_id: 'loc-A', role: 'staff', unifi_door_ids: [], permissions: {} }
    const a = mapProfileLocationToAssignment(pl)
    expect(a.unifi_door_ids).toEqual([])
  })

  it('passes null through (legacy fallback for manager+ roles after mig 182)', () => {
    const pl = { location_id: 'loc-A', role: 'manager', unifi_door_ids: null, permissions: {} }
    const a = mapProfileLocationToAssignment(pl)
    expect(a.unifi_door_ids).toBeNull()
  })

  it('surfaces unifi_user_id so the door-provisioning picker can pre-select it', () => {
    const pl = {
      location_id: 'loc-A',
      role: 'staff',
      unifi_user_id: 'unifi-user-1',
      permissions: {},
    }
    const a = mapProfileLocationToAssignment(pl)
    expect(a.unifi_user_id).toBe('unifi-user-1')
  })
})

describe('mapProfileLocationToAssignment — preserves permissions', () => {
  it('passes the permissions JSONB through unmodified', () => {
    // The bug was that the staff edit page narrowed its SELECT to
    // exclude `permissions`, so the form received undefined and
    // fell back to role defaults — making every saved override
    // look like it was wiped on next refresh.
    const pl = {
      location_id: 'loc-A',
      role: 'manager',
      is_default: true,
      unifi_door_access: false,
      permissions: { pipeline: false, schedule: false, mobile: { schedule: true } },
    }
    const a = mapProfileLocationToAssignment(pl)
    expect(a.permissions).toEqual({ pipeline: false, schedule: false, mobile: { schedule: true } })
    expect(a.role).toBe('manager')
    expect(a.is_default).toBe(true)
    expect(a.unifi_door_access).toBe(false)
  })

  it('treats null permissions as empty object (form falls through to role defaults)', () => {
    const a = mapProfileLocationToAssignment({
      location_id: 'loc-A', role: 'staff', permissions: null,
    })
    expect(a.permissions).toEqual({})
  })

  it('returns null on null input (defensive)', () => {
    expect(mapProfileLocationToAssignment(null)).toBe(null)
  })
})

describe('canEditStaffMember — owner cannot edit themselves or peers', () => {
  // STAFF-EDIT-RULE.1 — the rule is per-LOCATION now, so the fixtures carry
  // locations: `rolesByLocation` for the caller (the per-location truth) and
  // `locationIds` for the target. `role` stays on the caller because it is
  // still the ACTIVE-location role the rest of getCurrentUser exposes — and
  // several cases below exist precisely to prove it is no longer what
  // decides the answer.
  const master   = { id: 'u1', role: 'master', isMaster: true }
  const ownerA   = { id: 'u2', role: 'owner', rolesByLocation: { A: 'owner' } }
  const ownerB   = { id: 'u3', role: 'owner', rolesByLocation: { B: 'owner' }, locationIds: ['B'] }
  const manager  = { id: 'u4', role: 'manager', locationIds: ['A'] }
  const staffer  = { id: 'u5', role: 'staff', locationIds: ['A'] }

  it('master can edit anyone (including themselves)', () => {
    expect(canEditStaffMember(master, master)).toBe(true)
    expect(canEditStaffMember(master, ownerA)).toBe(true)
    expect(canEditStaffMember(master, manager)).toBe(true)
    expect(canEditStaffMember(master, staffer)).toBe(true)
  })

  it('owner CANNOT edit themselves', () => {
    expect(canEditStaffMember(ownerA, ownerA)).toBe(false)
  })

  it('owner CANNOT edit another owner', () => {
    expect(canEditStaffMember(ownerA, ownerB)).toBe(false)
  })

  it('owner CAN edit manager / head_coach / staff at a location they own', () => {
    expect(canEditStaffMember(ownerA, manager)).toBe(true)
    expect(canEditStaffMember(ownerA, { id: 'hc', role: 'head_coach', locationIds: ['A'] })).toBe(true)
    expect(canEditStaffMember(ownerA, staffer)).toBe(true)
  })

  // ── STAFF-EDIT-RULE.1: the location half the doc always claimed ──────
  it('owner CANNOT edit someone who works only where the caller is NOT owner', () => {
    // The cross-org shape: a real owner, a target at another studio. The
    // write was already refused deeper (assertOwnerAssignmentScope); the
    // helper used to say yes and let the page render the form.
    expect(canEditStaffMember(ownerA, { id: 'x', role: 'staff', locationIds: ['B'] })).toBe(false)
  })

  it('owner CAN edit at their own studio even when their ACTIVE role is not owner', () => {
    // The mirror-image false refusal: `role` is the ACTIVE-location role, so
    // an owner at A whose active studio is elsewhere used to be refused a
    // record entirely theirs.
    const ownerAtAButActiveStaff = {
      id: 'u9', role: 'staff', rolesByLocation: { Z: 'staff', A: 'owner' },
    }
    expect(canEditStaffMember(ownerAtAButActiveStaff, staffer)).toBe(true)
  })

  it('owner CANNOT edit a target assigned nowhere — the PUT refuses it too', () => {
    expect(canEditStaffMember(ownerA, { id: 'orphan', role: 'staff', locationIds: [] })).toBe(false)
  })

  it('a target with NO locationIds denies — the rule fails closed, never open', () => {
    // A call site that forgets to pass them must lose access, not gain it.
    expect(canEditStaffMember(ownerA, { id: 'x', role: 'staff' })).toBe(false)
  })

  it('an ACTIVE-role owner who owns NO location cannot edit anyone', () => {
    const ownerNowhere = { id: 'u8', role: 'owner', rolesByLocation: { A: 'manager' } }
    expect(canEditStaffMember(ownerNowhere, staffer)).toBe(false)
  })

  it('master is still exempt from every location rule', () => {
    expect(canEditStaffMember(master, { id: 'x', role: 'staff', locationIds: [] })).toBe(true)
    expect(canEditStaffMember(master, { id: 'y', role: 'staff', locationIds: ['Z'] })).toBe(true)
  })

  it('non-owner / non-master cannot use the editor at all', () => {
    expect(canEditStaffMember(manager, staffer)).toBe(false)
    expect(canEditStaffMember(staffer, staffer)).toBe(false)
  })

  it('null / undefined inputs deny safely', () => {
    expect(canEditStaffMember(null, ownerA)).toBe(false)
    expect(canEditStaffMember(ownerA, null)).toBe(false)
    expect(canEditStaffMember(null, null)).toBe(false)
  })
})

describe('canOverrideStaffPassword — AUTH.1 cross-org takeover guard', () => {
  const master = { id: 'm1', role: 'master', isMaster: true }
  // Owner of locations A + B.
  const ownerAB = {
    id: 'o1', role: 'owner', locations: [{ id: 'A' }, { id: 'B' }],
    // STAFF-EDIT-RULE.1 — canEditStaffMember (which this reuses) now reads
    // the per-location roles, so "owner of A + B" has to say so.
    rolesByLocation: { A: 'owner', B: 'owner' },
  }

  it('master can reset anyone, regardless of location', () => {
    expect(canOverrideStaffPassword(master, { id: 's', role: 'staff', locationIds: ['Z'] })).toBe(true)
    expect(canOverrideStaffPassword(master, { id: 'o2', role: 'owner', locationIds: ['Z'] })).toBe(true)
    expect(canOverrideStaffPassword(master, { id: 'm2', role: 'master', locationIds: ['Z'] })).toBe(true)
  })

  it('owner CAN reset a manager/staff who shares one of their locations', () => {
    expect(canOverrideStaffPassword(ownerAB, { id: 's', role: 'staff', locationIds: ['B'] })).toBe(true)
    expect(canOverrideStaffPassword(ownerAB, { id: 'mg', role: 'manager', locationIds: ['A', 'C'] })).toBe(true)
    expect(canOverrideStaffPassword(ownerAB, { id: 'hc', role: 'head_coach', locationIds: ['A'] })).toBe(true)
  })

  it('owner CANNOT reset a staffer at a location they do not own (cross-org block)', () => {
    expect(canOverrideStaffPassword(ownerAB, { id: 's', role: 'staff', locationIds: ['Z'] })).toBe(false)
    expect(canOverrideStaffPassword(ownerAB, { id: 's', role: 'staff', locationIds: [] })).toBe(false)
  })

  it('owner CANNOT reset another owner (peer) even at a shared location', () => {
    expect(canOverrideStaffPassword(ownerAB, { id: 'o2', role: 'owner', locationIds: ['A'] })).toBe(false)
  })

  it('owner CANNOT reset a master (privilege escalation block)', () => {
    expect(canOverrideStaffPassword(ownerAB, { id: 'm2', role: 'master', locationIds: ['A'] })).toBe(false)
  })

  it('owner CANNOT reset themselves', () => {
    expect(canOverrideStaffPassword(ownerAB, { id: 'o1', role: 'owner', locationIds: ['A'] })).toBe(false)
  })

  it('non-owner / non-master callers are denied', () => {
    const manager = { id: 'mg', role: 'manager', locations: [{ id: 'A' }] }
    expect(canOverrideStaffPassword(manager, { id: 's', role: 'staff', locationIds: ['A'] })).toBe(false)
  })

  it('null / undefined inputs deny safely', () => {
    expect(canOverrideStaffPassword(null, { id: 's', role: 'staff' })).toBe(false)
    expect(canOverrideStaffPassword(ownerAB, null)).toBe(false)
  })
})

describe('canEditLocationFeatures — master only', () => {
  it('master is allowed', () => {
    expect(canEditLocationFeatures({ role: 'master', isMaster: true })).toBe(true)
    // Defensive: isMaster=true even when role is something else.
    expect(canEditLocationFeatures({ role: 'owner', isMaster: true })).toBe(true)
  })

  it('owner is denied', () => {
    expect(canEditLocationFeatures({ role: 'owner' })).toBe(false)
  })

  it('every other role denied', () => {
    expect(canEditLocationFeatures({ role: 'manager' })).toBe(false)
    expect(canEditLocationFeatures({ role: 'head_coach' })).toBe(false)
    expect(canEditLocationFeatures({ role: 'staff' })).toBe(false)
    expect(canEditLocationFeatures(null)).toBe(false)
  })
})
