import { describe, it, expect } from 'vitest'
import { buildStaffAssignmentsPatch, hydratePermissions } from './staff-edit.js'
import {
  DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
} from '../../shared/permissions.js'

const current = [
  { location_id: 'loc-1', role: 'staff', is_default: true, permissions: { pipeline: true }, unifi_door_access: true, unifi_user_id: 'u1', unifi_door_ids: ['d1'] },
  { location_id: 'loc-2', role: 'manager', is_default: false, permissions: { sms: true }, unifi_door_access: false },
]

describe('buildStaffAssignmentsPatch', () => {
  it('master: includes ALL assignments (full desired state)', () => {
    const out = buildStaffAssignmentsPatch({ isMaster: true, ownedLocationIds: [], currentAssignments: current, roleEdits: {} })
    expect(out.map(a => a.location_id).sort()).toEqual(['loc-1', 'loc-2'])
  })

  it('owner: includes ONLY owned-location assignments (server preserves the rest)', () => {
    const out = buildStaffAssignmentsPatch({ isMaster: false, ownedLocationIds: ['loc-1'], currentAssignments: current, roleEdits: {} })
    expect(out.map(a => a.location_id)).toEqual(['loc-1'])
  })

  it('applies a role edit to the named location, leaving others at their current role', () => {
    const out = buildStaffAssignmentsPatch({ isMaster: true, ownedLocationIds: [], currentAssignments: current, roleEdits: { 'loc-1': 'head_coach' } })
    expect(out.find(a => a.location_id === 'loc-1').role).toBe('head_coach')
    expect(out.find(a => a.location_id === 'loc-2').role).toBe('manager')
  })

  it('PRESERVES permissions + door access + is_default for every emitted assignment (the wipe guard)', () => {
    const out = buildStaffAssignmentsPatch({ isMaster: true, ownedLocationIds: [], currentAssignments: current, roleEdits: { 'loc-1': 'owner' } })
    const a1 = out.find(a => a.location_id === 'loc-1')
    expect(a1.permissions).toEqual({ pipeline: true })
    expect(a1.unifi_door_access).toBe(true)
    expect(a1.is_default).toBe(true)
  })

  it('OMITS unifi_user_id and the door/AC/face allowlist keys (so the server leaves them unchanged)', () => {
    const out = buildStaffAssignmentsPatch({ isMaster: true, ownedLocationIds: [], currentAssignments: current, roleEdits: {} })
    const a1 = out.find(a => a.location_id === 'loc-1')
    expect('unifi_user_id' in a1).toBe(false)
    expect('unifi_door_ids' in a1).toBe(false)
    expect('ac_device_ids' in a1).toBe(false)
    expect('protect_face_id' in a1).toBe(false)
  })

  it('defaults a missing permissions blob to {} (never undefined → never wipes via undefined)', () => {
    const out = buildStaffAssignmentsPatch({ isMaster: true, ownedLocationIds: [], currentAssignments: [{ location_id: 'x', role: 'staff', is_default: true, unifi_door_access: false }], roleEdits: {} })
    expect(out[0].permissions).toEqual({})
  })

  it('returns [] for no current assignments', () => {
    expect(buildStaffAssignmentsPatch({ isMaster: true, ownedLocationIds: [], currentAssignments: [], roleEdits: {} })).toEqual([])
  })
})

describe('buildStaffAssignmentsPatch — owner privilege boundary (C2c-i.1 review)', () => {
  it('owner does NOT emit a non-owned location even when roleEdits names it', () => {
    const current = [
      { location_id: 'loc-1', role: 'staff', is_default: true, permissions: {}, unifi_door_access: false },
      { location_id: 'loc-2', role: 'manager', is_default: false, permissions: {}, unifi_door_access: false },
    ]
    const out = buildStaffAssignmentsPatch({
      isMaster: false,
      ownedLocationIds: ['loc-1'],
      currentAssignments: current,
      roleEdits: { 'loc-2': 'head_coach' }, // attempt to edit a non-owned location
    })
    expect(out.some(a => a.location_id === 'loc-2')).toBe(false)
    expect(out.map(a => a.location_id)).toEqual(['loc-1'])
  })
})

describe('buildStaffAssignmentsPatch — permission edits (C2c-ii)', () => {
  it('applies a full permission blob to the named location, echoing raw permissions elsewhere', () => {
    const edited = { pipeline: false, contacts: true, mobile: { schedule: true } }
    const out = buildStaffAssignmentsPatch({
      isMaster: true, ownedLocationIds: [], currentAssignments: current,
      roleEdits: {}, permissionEdits: { 'loc-1': edited },
    })
    expect(out.find(a => a.location_id === 'loc-1').permissions).toEqual(edited)
    // loc-2 was not touched → its raw blob is echoed unchanged (no freeze).
    expect(out.find(a => a.location_id === 'loc-2').permissions).toEqual({ sms: true })
  })

  it('preserves role + door + is_default when only permissions are edited', () => {
    const out = buildStaffAssignmentsPatch({
      isMaster: true, ownedLocationIds: [], currentAssignments: current,
      roleEdits: {}, permissionEdits: { 'loc-1': { pipeline: false } },
    })
    const a1 = out.find(a => a.location_id === 'loc-1')
    expect(a1.role).toBe('staff')            // role untouched
    expect(a1.unifi_door_access).toBe(true)   // door untouched
    expect(a1.is_default).toBe(true)          // default untouched
  })

  it('combines a role edit and a permission edit on the same location', () => {
    const out = buildStaffAssignmentsPatch({
      isMaster: true, ownedLocationIds: [], currentAssignments: current,
      roleEdits: { 'loc-1': 'manager' }, permissionEdits: { 'loc-1': { pipeline: true } },
    })
    const a1 = out.find(a => a.location_id === 'loc-1')
    expect(a1.role).toBe('manager')
    expect(a1.permissions).toEqual({ pipeline: true })
  })

  it('owner does NOT emit a permission edit for a non-owned location (privilege boundary)', () => {
    const out = buildStaffAssignmentsPatch({
      isMaster: false, ownedLocationIds: ['loc-1'], currentAssignments: current,
      roleEdits: {}, permissionEdits: { 'loc-2': { pipeline: true } },
    })
    expect(out.some(a => a.location_id === 'loc-2')).toBe(false)
    expect(out.map(a => a.location_id)).toEqual(['loc-1'])
  })
})

describe('hydratePermissions (C2c-ii)', () => {
  it('empty blob → the role full web+mobile default blob', () => {
    expect(hydratePermissions({}, 'staff')).toEqual({
      ...DEFAULT_WEB_PERMISSIONS_BY_ROLE.staff,
      mobile: { ...DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.staff },
    })
  })

  it('null / undefined → role defaults', () => {
    const expected = {
      ...DEFAULT_WEB_PERMISSIONS_BY_ROLE.manager,
      mobile: { ...DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.manager },
    }
    expect(hydratePermissions(null, 'manager')).toEqual(expected)
    expect(hydratePermissions(undefined, 'manager')).toEqual(expected)
  })

  it('non-empty blob is used as-is, with .mobile hydrated from role defaults when absent', () => {
    const out = hydratePermissions({ pipeline: false, contacts: true }, 'staff')
    expect(out.pipeline).toBe(false)
    expect(out.contacts).toBe(true)
    expect(out.mobile).toEqual(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.staff)
  })

  it('preserves an explicit .mobile sub-object (does not overwrite with defaults)', () => {
    const out = hydratePermissions({ pipeline: true, mobile: { schedule: false } }, 'staff')
    expect(out.mobile).toEqual({ schedule: false })
  })

  it('does NOT back-fill sparse web keys (mirrors web — no over-hydration)', () => {
    const out = hydratePermissions({ pipeline: true, mobile: { schedule: true } }, 'staff')
    expect(out.contacts).toBeUndefined()
  })
})

describe('buildStaffAssignmentsPatch — add/remove assignments (C3-wizard.2)', () => {
  it('master: removing a location OMITS it from the payload (the server deletes it)', () => {
    const out = buildStaffAssignmentsPatch({
      isMaster: true, ownedLocationIds: [], currentAssignments: current,
      roleEdits: {}, removedLocationIds: ['loc-2'],
    })
    expect(out.map(a => a.location_id)).toEqual(['loc-1'])
  })

  it('owner: removing an OWNED location omits it; a non-owned one was never emitted (server preserves it)', () => {
    const out = buildStaffAssignmentsPatch({
      isMaster: false, ownedLocationIds: ['loc-1'], currentAssignments: current,
      roleEdits: {}, removedLocationIds: ['loc-1'],
    })
    expect(out.length).toBe(0)
  })

  it('master: adding a studio appends a new assignment (role, default false, empty perms, door off)', () => {
    const out = buildStaffAssignmentsPatch({
      isMaster: true, ownedLocationIds: [], currentAssignments: current,
      roleEdits: {}, addedAssignments: [{ location_id: 'loc-3', role: 'head_coach' }],
    })
    expect(out.find(a => a.location_id === 'loc-3')).toEqual({
      location_id: 'loc-3', role: 'head_coach', is_default: false, permissions: {}, unifi_door_access: false,
    })
  })

  it('owner: can add at an OWNED location but NOT a non-owned one (privilege boundary)', () => {
    const out = buildStaffAssignmentsPatch({
      isMaster: false, ownedLocationIds: ['loc-1', 'loc-9'], currentAssignments: current,
      roleEdits: {}, addedAssignments: [
        { location_id: 'loc-9', role: 'staff' },  // owned → added
        { location_id: 'loc-8', role: 'owner' },  // NOT owned → skipped
      ],
    })
    expect(out.some(a => a.location_id === 'loc-9')).toBe(true)
    expect(out.some(a => a.location_id === 'loc-8')).toBe(false)
  })

  it('never duplicates an added location that is already assigned (keeps the existing row)', () => {
    const out = buildStaffAssignmentsPatch({
      isMaster: true, ownedLocationIds: [], currentAssignments: current,
      roleEdits: {}, addedAssignments: [{ location_id: 'loc-1', role: 'manager' }],
    })
    expect(out.filter(a => a.location_id === 'loc-1').length).toBe(1)
    expect(out.find(a => a.location_id === 'loc-1').role).toBe('staff') // existing row preserved, not the add
  })

  it('add + remove of the SAME location is a no-op (the location ends up removed)', () => {
    const out = buildStaffAssignmentsPatch({
      isMaster: true, ownedLocationIds: [], currentAssignments: current,
      roleEdits: {}, removedLocationIds: ['loc-2'], addedAssignments: [{ location_id: 'loc-2', role: 'owner' }],
    })
    expect(out.some(a => a.location_id === 'loc-2')).toBe(false)
  })

  it('combines a role edit, a removal, and an addition in one payload', () => {
    const out = buildStaffAssignmentsPatch({
      isMaster: true, ownedLocationIds: [], currentAssignments: current,
      roleEdits: { 'loc-1': 'manager' },
      removedLocationIds: ['loc-2'],
      addedAssignments: [{ location_id: 'loc-3', role: 'staff' }],
    })
    expect(out.map(a => a.location_id).sort()).toEqual(['loc-1', 'loc-3'])
    expect(out.find(a => a.location_id === 'loc-1').role).toBe('manager')
    expect(out.find(a => a.location_id === 'loc-3').role).toBe('staff')
  })
})
