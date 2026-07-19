import { describe, it, expect } from 'vitest'
import { buildStaffProfilePatch, computeProfileRole, assertOwnerAssignmentScope, computeDesiredAssignments, sparsifyAssignmentPermissions } from './staff-write.js'
import { hydratePermissions } from '@shared/permissions'

describe('buildStaffProfilePatch', () => {
  it('includes only the profile keys present in the body', () => {
    const patch = buildStaffProfilePatch({ full_name: 'Ada', active: true, irrelevant: 'x' })
    expect(patch).toEqual({ full_name: 'Ada', active: true })
  })
  it('includes all nine recognised keys when present, preserving null/false', () => {
    const body = {
      full_name: 'A', permissions: {}, active: false, employment_type: 'contractor',
      annual_salary: null, hourly_rate: 12, contracted_hours_per_week: 40,
      annual_leave_entitlement: 20, overtime_rate: null,
    }
    expect(buildStaffProfilePatch(body)).toEqual(body)
  })
  it('is empty for a body with no recognised keys', () => {
    expect(buildStaffProfilePatch({ is_master: true, assignments: [] })).toEqual({})
  })
})

describe('computeProfileRole', () => {
  it('returns master when isMaster is true regardless of assignments', () => {
    expect(computeProfileRole({ isMaster: true, assignmentRoles: ['staff'], fallbackRole: 'staff' })).toBe('master')
  })
  it('returns the highest-precedence assignment role', () => {
    expect(computeProfileRole({ isMaster: false, assignmentRoles: ['staff', 'owner', 'manager'], fallbackRole: 'staff' })).toBe('owner')
    expect(computeProfileRole({ isMaster: false, assignmentRoles: ['staff', 'head_coach'], fallbackRole: 'staff' })).toBe('head_coach')
  })
  it('falls back when there are no assignments', () => {
    expect(computeProfileRole({ isMaster: false, assignmentRoles: [], fallbackRole: 'manager' })).toBe('manager')
    expect(computeProfileRole({ isMaster: false, assignmentRoles: [], fallbackRole: null })).toBe('staff')
  })
})

describe('assertOwnerAssignmentScope', () => {
  const ownerLocs = ['loc-1', 'loc-2']

  it('master bypasses owner-overlap but still rejects an invalid role', () => {
    expect(assertOwnerAssignmentScope({ isMaster: true, callerOwnerLocationIds: [], targetLocationIds: ['x'], assignments: [{ location_id: 'x', role: 'staff' }] })).toBeNull()
    const bad = assertOwnerAssignmentScope({ isMaster: true, callerOwnerLocationIds: [], targetLocationIds: ['x'], assignments: [{ location_id: 'x', role: 'master' }] })
    expect(bad?.status).toBe(403)
  })

  it('owner with no location overlap is rejected', () => {
    const r = assertOwnerAssignmentScope({ isMaster: false, callerOwnerLocationIds: ownerLocs, targetLocationIds: ['loc-9'], assignments: undefined })
    expect(r?.status).toBe(403)
    expect(r.error).toMatch(/owner/i)
  })

  it('owner with overlap and no assignments passes', () => {
    expect(assertOwnerAssignmentScope({ isMaster: false, callerOwnerLocationIds: ownerLocs, targetLocationIds: ['loc-1'], assignments: undefined })).toBeNull()
  })

  it('owner cannot assign at a non-owned location', () => {
    const r = assertOwnerAssignmentScope({ isMaster: false, callerOwnerLocationIds: ownerLocs, targetLocationIds: ['loc-1'], assignments: [{ location_id: 'loc-9', role: 'staff' }] })
    expect(r?.status).toBe(403)
    expect(r.error).toMatch(/where you are an owner/i)
  })

  it('owner cannot grant a role outside OWNER_ASSIGNABLE_ROLES', () => {
    const r = assertOwnerAssignmentScope({ isMaster: false, callerOwnerLocationIds: ownerLocs, targetLocationIds: ['loc-1'], assignments: [{ location_id: 'loc-1', role: 'master' }] })
    expect(r?.status).toBe(403)
  })

  it('owner assigning a valid role at an owned location passes', () => {
    expect(assertOwnerAssignmentScope({ isMaster: false, callerOwnerLocationIds: ownerLocs, targetLocationIds: ['loc-1'], assignments: [{ location_id: 'loc-1', role: 'manager' }] })).toBeNull()
  })
})

describe('computeDesiredAssignments', () => {
  const existing = [
    { location_id: 'loc-1', role: 'staff', is_default: true, unifi_door_access: false, permissions: { x: 1 } },
    { location_id: 'loc-2', role: 'manager', is_default: false, unifi_door_access: true, permissions: { y: 2 } },
  ]

  it('master: desired is exactly the body assignments', () => {
    const out = computeDesiredAssignments({ isMaster: true, callerOwnerLocationIds: [], assignments: [{ location_id: 'loc-1', role: 'owner', is_default: true }], existingLinks: existing })
    expect(out).toEqual([{ location_id: 'loc-1', role: 'owner', is_default: true }])
  })

  it('owner: keeps body rows at owned locations, preserves non-owned existing rows verbatim (incl. permissions)', () => {
    const out = computeDesiredAssignments({
      isMaster: false, callerOwnerLocationIds: ['loc-1'],
      assignments: [{ location_id: 'loc-1', role: 'head_coach', is_default: true }],
      existingLinks: existing,
    })
    expect(out).toContainEqual({ location_id: 'loc-1', role: 'head_coach', is_default: true })
    expect(out).toContainEqual({ location_id: 'loc-2', role: 'manager', is_default: false, unifi_door_access: true, permissions: { y: 2 } })
  })

  it('promotes the first row to default when none is marked', () => {
    const out = computeDesiredAssignments({ isMaster: true, callerOwnerLocationIds: [], assignments: [{ location_id: 'a', role: 'staff' }, { location_id: 'b', role: 'staff' }], existingLinks: [] })
    expect(out[0].is_default).toBe(true)
    expect(out[1].is_default).toBeFalsy()
  })

  it('keeps exactly one default when several are marked', () => {
    const out = computeDesiredAssignments({ isMaster: true, callerOwnerLocationIds: [], assignments: [{ location_id: 'a', role: 'staff', is_default: true }, { location_id: 'b', role: 'staff', is_default: true }], existingLinks: [] })
    expect(out.filter(a => a.is_default)).toHaveLength(1)
    expect(out[0].is_default).toBe(true)
  })

  it('preserves a non-owned existing row with an empty permissions object when it had none', () => {
    const out = computeDesiredAssignments({ isMaster: false, callerOwnerLocationIds: ['loc-1'], assignments: [], existingLinks: [{ location_id: 'loc-2', role: 'staff', is_default: true, unifi_door_access: false, permissions: null }] })
    expect(out).toContainEqual({ location_id: 'loc-2', role: 'staff', is_default: true, unifi_door_access: false, permissions: {} })
  })
})

import { applyStaffProfileWrite } from './staff-write.js'
import { vi, beforeEach } from 'vitest'

// Mock the compensation helpers so we can assert the dual-write.
vi.mock('@/lib/profile-compensation', () => ({
  splitCompFromProfilePatch: vi.fn((p) => ({ compFields: p })),
  upsertCompensationForProfile: vi.fn(async () => ({ ok: true })),
}))
import { splitCompFromProfilePatch, upsertCompensationForProfile } from '@/lib/profile-compensation'

function mockDb({ updateError = null } = {}) {
  const eq = vi.fn(async () => ({ error: updateError }))
  const update = vi.fn(() => ({ eq }))
  return { update, from: vi.fn(() => ({ update })) }
}

describe('applyStaffProfileWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    splitCompFromProfilePatch.mockImplementation((p) => ({ compFields: p }))
    upsertCompensationForProfile.mockResolvedValue({ ok: true })
  })

  it('updates profiles with the patch when body has profile fields', async () => {
    const db = mockDb()
    const res = await applyStaffProfileWrite({ db, id: 'p1', body: { full_name: 'Ada' }, actorId: 'u1' })
    expect(db.from).toHaveBeenCalledWith('profiles')
    expect(db.update).toHaveBeenCalledWith({ full_name: 'Ada' })
    expect(res).toEqual({ ok: true })
  })

  it('does not touch profiles when the body has no profile fields', async () => {
    const db = mockDb()
    await applyStaffProfileWrite({ db, id: 'p1', body: { assignments: [] }, actorId: 'u1' })
    expect(db.update).not.toHaveBeenCalled()
  })

  it('returns ok:false with the db error message on a profiles update failure', async () => {
    const db = mockDb({ updateError: { message: 'boom' } })
    const res = await applyStaffProfileWrite({ db, id: 'p1', body: { full_name: 'X' }, actorId: 'u1' })
    expect(res).toEqual({ ok: false, error: 'boom' })
  })

  it('upserts compensation with only the defined comp fields', async () => {
    const db = mockDb()
    await applyStaffProfileWrite({ db, id: 'p1', body: { hourly_rate: 12, annual_salary: undefined }, actorId: 'u1' })
    expect(upsertCompensationForProfile).toHaveBeenCalledWith(db, 'p1', { hourly_rate: 12 }, { actorId: 'u1' })
  })

  it('skips the comp upsert when no comp fields are present', async () => {
    const db = mockDb()
    await applyStaffProfileWrite({ db, id: 'p1', body: { full_name: 'Ada' }, actorId: 'u1' })
    expect(upsertCompensationForProfile).not.toHaveBeenCalled()
  })

  it('returns ok:false with a compensation-prefixed error when the upsert fails', async () => {
    upsertCompensationForProfile.mockResolvedValue({ ok: false, error: 'locked' })
    const db = mockDb()
    const res = await applyStaffProfileWrite({ db, id: 'p1', body: { hourly_rate: 9 }, actorId: 'u1' })
    expect(res).toEqual({ ok: false, error: 'compensation: locked' })
  })
})

describe('staff-write — characterization completeness (C2b.1 review)', () => {
  it('buildStaffProfilePatch skips a known key whose value is explicitly undefined', () => {
    expect(buildStaffProfilePatch({ full_name: undefined, active: true })).toEqual({ active: true })
  })
  it('assertOwnerAssignmentScope returns null for master with no assignments', () => {
    expect(assertOwnerAssignmentScope({ isMaster: true, callerOwnerLocationIds: [], targetLocationIds: ['x'], assignments: undefined })).toBeNull()
  })
  it('computeDesiredAssignments (owner) silently drops a body row at a non-owned location', () => {
    const out = computeDesiredAssignments({
      isMaster: false,
      callerOwnerLocationIds: ['loc-1'],
      assignments: [{ location_id: 'loc-9', role: 'staff', is_default: true }],
      existingLinks: [],
    })
    expect(out.find(a => a.location_id === 'loc-9')).toBeUndefined()
  })
})

describe('applyStaffProfileWrite — ordering guarantee (C2b.2a review)', () => {
  it('does NOT attempt the comp upsert when the profiles update fails (early return)', async () => {
    vi.clearAllMocks() // this describe has no beforeEach; start from a clean call count
    upsertCompensationForProfile.mockResolvedValue({ ok: true })
    const eq = vi.fn(async () => ({ error: { message: 'boom' } }))
    const update = vi.fn(() => ({ eq }))
    const db = { update, from: vi.fn(() => ({ update })) }
    const res = await applyStaffProfileWrite({ db, id: 'p1', body: { full_name: 'X', hourly_rate: 9 }, actorId: 'u1' })
    expect(res).toEqual({ ok: false, error: 'boom' })
    expect(upsertCompensationForProfile).not.toHaveBeenCalled()
  })
})

import { buildAssignmentRow } from './staff-write.js'

describe('buildAssignmentRow', () => {
  const base = { location_id: 'loc-1', role: 'staff', is_default: 1, permissions: { x: 1 } }
  const common = { id: 'p1', wantsDoor: true, unifiUserId: 'u9', syncedAt: '2026-01-01T00:00:00.000Z' }

  it('builds the base row with no optional keys present', () => {
    const row = buildAssignmentRow({ ...common, assignment: base })
    expect(row).toEqual({
      profile_id: 'p1',
      location_id: 'loc-1',
      role: 'staff',
      is_default: true, // coerced from 1
      unifi_door_access: true,
      unifi_synced_at: '2026-01-01T00:00:00.000Z',
      unifi_user_id: 'u9',
      permissions: { x: 1 },
    })
    expect('protect_face_id' in row).toBe(false)
    expect('unifi_door_ids' in row).toBe(false)
    expect('ac_device_ids' in row).toBe(false)
  })

  it('permissions defaults to {} when null/absent', () => {
    expect(buildAssignmentRow({ ...common, assignment: { ...base, permissions: null } }).permissions).toEqual({})
    const { permissions: _permissions, ...noPerm } = base
    expect(buildAssignmentRow({ ...common, assignment: noPerm }).permissions).toEqual({})
  })

  it('is_default coerces to a real boolean', () => {
    expect(buildAssignmentRow({ ...common, assignment: { ...base, is_default: 0 } }).is_default).toBe(false)
    expect(buildAssignmentRow({ ...common, assignment: { ...base, is_default: undefined } }).is_default).toBe(false)
  })

  it('protect_face_id: string sets, null clears, omitting the key leaves it absent', () => {
    expect(buildAssignmentRow({ ...common, assignment: { ...base, protect_face_id: 'face1' } }).protect_face_id).toBe('face1')
    expect(buildAssignmentRow({ ...common, assignment: { ...base, protect_face_id: null } }).protect_face_id).toBeNull()
    expect('protect_face_id' in buildAssignmentRow({ ...common, assignment: base })).toBe(false)
  })

  it('unifi_door_ids: null→null, array→array, []→[], omit→absent', () => {
    expect(buildAssignmentRow({ ...common, assignment: { ...base, unifi_door_ids: null } }).unifi_door_ids).toBeNull()
    expect(buildAssignmentRow({ ...common, assignment: { ...base, unifi_door_ids: ['d1'] } }).unifi_door_ids).toEqual(['d1'])
    expect(buildAssignmentRow({ ...common, assignment: { ...base, unifi_door_ids: [] } }).unifi_door_ids).toEqual([])
    expect('unifi_door_ids' in buildAssignmentRow({ ...common, assignment: base })).toBe(false)
  })

  it('ac_device_ids: null→null, array→array, []→[], omit→absent', () => {
    expect(buildAssignmentRow({ ...common, assignment: { ...base, ac_device_ids: null } }).ac_device_ids).toBeNull()
    expect(buildAssignmentRow({ ...common, assignment: { ...base, ac_device_ids: ['a1'] } }).ac_device_ids).toEqual(['a1'])
    expect(buildAssignmentRow({ ...common, assignment: { ...base, ac_device_ids: [] } }).ac_device_ids).toEqual([])
    expect('ac_device_ids' in buildAssignmentRow({ ...common, assignment: base })).toBe(false)
  })
})

import { applyDoorAccessChange } from './staff-write.js'
import { syncStaffAssignments } from './staff-write.js'

vi.mock('@/lib/unifi-access', () => {
  class UnifiError extends Error {}
  const getLocationUnifiConfig = vi.fn()
  return {
    UnifiError,
    getLocationUnifiConfig,
    // INTEG-A2 dual-read wrapper — in tests it just runs the pure
    // legacy derivation, so the existing mockReturnValue calls on
    // getLocationUnifiConfig keep driving every scenario.
    getUnifiConfig: vi.fn(async (_db, location) => getLocationUnifiConfig(location)),
    findOrCreateUnifiUser: vi.fn(),
    syncUnifiUserPolicyForRole: vi.fn(),
    revokeUnifiUserPolicies: vi.fn(),
  }
})
import * as unifi from '@/lib/unifi-access'

describe('applyDoorAccessChange', () => {
  const location = { name: 'Hatch' }
  beforeEach(() => {
    vi.clearAllMocks()
    unifi.getLocationUnifiConfig.mockReturnValue({ configured: true })
    unifi.findOrCreateUnifiUser.mockResolvedValue('new-user')
    unifi.syncUnifiUserPolicyForRole.mockResolvedValue(undefined)
    unifi.revokeUnifiUserPolicies.mockResolvedValue(undefined)
  })

  it('disable + configured + existing id → revokes + returns the existing id', async () => {
    const out = await applyDoorAccessChange({ profile: {}, location, enable: false, role: 'staff', existingUnifiUserId: 'u1' })
    expect(unifi.revokeUnifiUserPolicies).toHaveBeenCalledWith({ configured: true }, 'u1')
    expect(out).toBe('u1')
  })

  it('disable + not configured → no revoke, returns existing||null', async () => {
    unifi.getLocationUnifiConfig.mockReturnValue({ configured: false })
    expect(await applyDoorAccessChange({ profile: {}, location, enable: false, role: 'staff', existingUnifiUserId: 'u1' })).toBe('u1')
    expect(await applyDoorAccessChange({ profile: {}, location, enable: false, role: 'staff', existingUnifiUserId: null })).toBeNull()
    expect(unifi.revokeUnifiUserPolicies).not.toHaveBeenCalled()
  })

  it('enable + not configured → throws UnifiError', async () => {
    unifi.getLocationUnifiConfig.mockReturnValue({ configured: false })
    await expect(applyDoorAccessChange({ profile: {}, location, enable: true, role: 'staff', existingUnifiUserId: null }))
      .rejects.toBeInstanceOf(unifi.UnifiError)
  })

  it('enable + configured + existing id → syncs policy, returns existing id (no find-or-create)', async () => {
    const out = await applyDoorAccessChange({ profile: {}, location, enable: true, role: 'manager', existingUnifiUserId: 'u1' })
    expect(unifi.findOrCreateUnifiUser).not.toHaveBeenCalled()
    expect(unifi.syncUnifiUserPolicyForRole).toHaveBeenCalledWith({ configured: true }, 'u1', 'manager')
    expect(out).toBe('u1')
  })

  it('enable + configured + no id + not skipping → find-or-create then sync, returns new id', async () => {
    const out = await applyDoorAccessChange({ profile: { id: 'p' }, location, enable: true, role: 'staff', existingUnifiUserId: null })
    expect(unifi.findOrCreateUnifiUser).toHaveBeenCalledWith({ configured: true }, { id: 'p' })
    expect(unifi.syncUnifiUserPolicyForRole).toHaveBeenCalledWith({ configured: true }, 'new-user', 'staff')
    expect(out).toBe('new-user')
  })

  it('enable + configured + no id + skipFindOrCreate → throws (no user id available)', async () => {
    await expect(applyDoorAccessChange({ profile: {}, location, enable: true, role: 'staff', existingUnifiUserId: null, skipFindOrCreate: true }))
      .rejects.toBeInstanceOf(unifi.UnifiError)
    expect(unifi.findOrCreateUnifiUser).not.toHaveBeenCalled()
  })
})

// A db mock for profile_locations delete/update/insert. Records calls.
function syncDb() {
  const calls = { deletes: [], updates: [], inserts: [] }
  return {
    calls,
    from() {
      return {
        delete: () => ({ eq: (k1, v1) => ({ eq: (k2, v2) => { calls.deletes.push([v1, v2]); return Promise.resolve({ error: null }) } }) }),
        update: (row) => ({ eq: (k1, v1) => ({ eq: (k2, v2) => { calls.updates.push({ row, where: [v1, v2] }); return Promise.resolve({ error: null }) } }) }),
        insert: (row) => { calls.inserts.push(row); return Promise.resolve({ error: null }) },
      }
    },
  }
}

describe('syncStaffAssignments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unifi.getLocationUnifiConfig.mockReturnValue({ configured: true })
    unifi.revokeUnifiUserPolicies.mockResolvedValue(undefined)
    unifi.syncUnifiUserPolicyForRole.mockResolvedValue(undefined)
    unifi.findOrCreateUnifiUser.mockResolvedValue('new-user')
  })

  it('deletes an existing row not in the desired set (with revoke when door+user+configured)', async () => {
    const db = syncDb()
    const targetBefore = { id: 'p1', profile_locations: [
      { location_id: 'gone', unifi_door_access: true, unifi_user_id: 'u9', locations: { name: 'Old' } },
    ] }
    const res = await syncStaffAssignments({
      db, id: 'p1', targetBefore,
      desired: [], desiredIds: new Set(), existingByLocation: {},
    })
    expect(unifi.revokeUnifiUserPolicies).toHaveBeenCalledWith({ configured: true }, 'u9')
    expect(db.calls.deletes).toEqual([['p1', 'gone']])
    expect(res.unifiErrors).toEqual([])
  })

  it('does NOT revoke when the deleted row had no door access', async () => {
    const db = syncDb()
    const targetBefore = { id: 'p1', profile_locations: [
      { location_id: 'gone', unifi_door_access: false, unifi_user_id: 'u9', locations: { name: 'Old' } },
    ] }
    await syncStaffAssignments({ db, id: 'p1', targetBefore, desired: [], desiredIds: new Set(), existingByLocation: {} })
    expect(unifi.revokeUnifiUserPolicies).not.toHaveBeenCalled()
    expect(db.calls.deletes).toEqual([['p1', 'gone']])
  })

  it('inserts a brand-new desired row and runs the door sync', async () => {
    const db = syncDb()
    const desired = [{ location_id: 'loc-1', role: 'staff', is_default: true, unifi_door_access: true }]
    const existing = { 'loc-1': { unifi_user_id: null, locations: { name: 'Hatch' } } }
    await syncStaffAssignments({
      db, id: 'p1', targetBefore: { id: 'p1', profile_locations: [] },
      desired, desiredIds: new Set(['loc-1']),
      existingByLocation: existing,
    })
    // existing row present → it's an UPDATE (existingByLocation has loc-1)
    expect(db.calls.updates).toHaveLength(1)
    expect(db.calls.updates[0].where).toEqual(['p1', 'loc-1'])
    expect(unifi.syncUnifiUserPolicyForRole).toHaveBeenCalled()
  })

  it('inserts when there is no existing row for the location', async () => {
    const db = syncDb()
    const desired = [{ location_id: 'loc-new', role: 'staff', is_default: true, unifi_door_access: false }]
    await syncStaffAssignments({
      db, id: 'p1', targetBefore: { id: 'p1', profile_locations: [] },
      desired, desiredIds: new Set(['loc-new']), existingByLocation: {},
    })
    expect(db.calls.inserts).toHaveLength(1)
    expect(db.calls.inserts[0].location_id).toBe('loc-new')
  })

  it('aggregates a UniFi sync error and STILL writes the row (door toggle not applied, role still saved)', async () => {
    const db = syncDb()
    unifi.syncUnifiUserPolicyForRole.mockRejectedValue(new unifi.UnifiError('door offline'))
    const desired = [{ location_id: 'loc-1', role: 'manager', is_default: true, unifi_door_access: true }]
    const existing = { 'loc-1': { unifi_user_id: 'u1', locations: { name: 'Hatch' } } }
    const res = await syncStaffAssignments({
      db, id: 'p1', targetBefore: { id: 'p1', profile_locations: [] },
      desired, desiredIds: new Set(['loc-1']), existingByLocation: existing,
    })
    expect(res.unifiErrors.length).toBe(1)
    expect(res.unifiErrors[0]).toMatch(/door offline/)
    expect(db.calls.updates).toHaveLength(1) // row still written
  })
})

describe('syncStaffAssignments — door-access safety paths (C2b.2b-ii review)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unifi.getLocationUnifiConfig.mockReturnValue({ configured: true })
    unifi.revokeUnifiUserPolicies.mockResolvedValue(undefined)
  })

  it('still deletes the row when the door-revoke throws (a revoke failure must NOT block removal)', async () => {
    const db = syncDb()
    unifi.revokeUnifiUserPolicies.mockRejectedValue(new unifi.UnifiError('controller down'))
    const targetBefore = { id: 'p1', profile_locations: [
      { location_id: 'gone', unifi_door_access: true, unifi_user_id: 'u9', locations: { name: 'Old' } },
    ] }
    const res = await syncStaffAssignments({ db, id: 'p1', targetBefore, desired: [], desiredIds: new Set(), existingByLocation: {} })
    expect(res.unifiErrors.length).toBe(1)
    expect(res.unifiErrors[0]).toMatch(/controller down/)
    expect(db.calls.deletes).toEqual([['p1', 'gone']]) // removed despite the revoke failure
  })

  it('skips the revoke when UniFi is not configured for the deleted location', async () => {
    const db = syncDb()
    unifi.getLocationUnifiConfig.mockReturnValue({ configured: false })
    const targetBefore = { id: 'p1', profile_locations: [
      { location_id: 'gone', unifi_door_access: true, unifi_user_id: 'u9', locations: { name: 'Old' } },
    ] }
    await syncStaffAssignments({ db, id: 'p1', targetBefore, desired: [], desiredIds: new Set(), existingByLocation: {} })
    expect(unifi.revokeUnifiUserPolicies).not.toHaveBeenCalled()
    expect(db.calls.deletes).toEqual([['p1', 'gone']])
  })
})

// PERM-AUDIT.3 — server-side sparsification of assignment blobs.
describe('sparsifyAssignmentPermissions', () => {
  function fakeDb(templateRows = []) {
    return {
      from: () => ({
        select: () => ({
          in: () => Promise.resolve({ data: templateRows, error: null }),
        }),
      }),
    }
  }

  it('reduces a full role-default blob to {} (pure inheritance)', async () => {
    const full = hydratePermissions(null, 'staff')
    const out = await sparsifyAssignmentPermissions({
      db: fakeDb(),
      assignments: [{ location_id: 'loc1', role: 'staff', is_default: true, permissions: full }],
    })
    expect(out[0].permissions).toEqual({})
    expect(out[0].is_default).toBe(true) // other fields untouched
  })

  it('keeps only the keys that differ from the role base', async () => {
    const full = hydratePermissions(null, 'staff')
    const edited = { ...full, email: true, mobile: { ...full.mobile, whatsapp: true } }
    const out = await sparsifyAssignmentPermissions({
      db: fakeDb(),
      assignments: [{ location_id: 'loc1', role: 'staff', permissions: edited }],
    })
    expect(out[0].permissions).toEqual({ email: true, mobile: { whatsapp: true } })
  })

  it('diffs against the role TEMPLATE when one exists (mig 364)', async () => {
    // Template already grants email to staff at loc1 — an edited blob
    // with email:true therefore matches the base and stores nothing.
    const template = { email: true }
    const base = hydratePermissions(null, 'staff', template)
    const out = await sparsifyAssignmentPermissions({
      db: fakeDb([{ location_id: 'loc1', role: 'staff', employment_type: 'all', permissions: template }]),
      assignments: [{ location_id: 'loc1', role: 'staff', permissions: base }],
    })
    expect(out[0].permissions).toEqual({})
  })

  // RECEPTION.2 (mig 367) — employment-type variants in the diff base.
  it('layers the employment-type variant over the all row when employmentType is passed', async () => {
    const rows = [
      { location_id: 'loc1', role: 'staff', employment_type: 'all', permissions: { email: true } },
      { location_id: 'loc1', role: 'staff', employment_type: 'contractor', permissions: { mobile: { tv_displays: true } } },
    ]
    // A contractor whose blob matches defaults + all + contractor
    // variant exactly → stores nothing.
    const base = hydratePermissions(null, 'staff', { email: true, mobile: { tv_displays: true } })
    const out = await sparsifyAssignmentPermissions({
      db: fakeDb(rows),
      assignments: [{ location_id: 'loc1', role: 'staff', permissions: base }],
      employmentType: 'contractor',
    })
    expect(out[0].permissions).toEqual({})
  })

  it('ignores variant rows for a non-matching employment type', async () => {
    const rows = [
      { location_id: 'loc1', role: 'staff', employment_type: 'contractor', permissions: { mobile: { tv_displays: true } } },
    ]
    // An FTE with tv_displays on differs from THEIR base (no variant
    // applies) → the key is stored as a per-user override.
    const full = hydratePermissions(null, 'staff')
    const edited = { ...full, mobile: { ...full.mobile, tv_displays: true } }
    const out = await sparsifyAssignmentPermissions({
      db: fakeDb(rows),
      assignments: [{ location_id: 'loc1', role: 'staff', permissions: edited }],
      employmentType: 'fte',
    })
    expect(out[0].permissions).toEqual({ mobile: { tv_displays: true } })
  })

  it('preserves the non-boolean mobile extras', async () => {
    const full = hydratePermissions(null, 'staff')
    const layout = { bar: ['studio'], allowed: ['studio', 'invoices'] }
    const edited = { ...full, mobile: { ...full.mobile, layout, lead_time_overrides: { tasks: 60 } } }
    const out = await sparsifyAssignmentPermissions({
      db: fakeDb(),
      assignments: [{ location_id: 'loc1', role: 'staff', permissions: edited }],
    })
    expect(out[0].permissions.mobile.layout).toEqual(layout)
    expect(out[0].permissions.mobile.lead_time_overrides).toEqual({ tasks: 60 })
  })

  it('an already-sparse blob passes through unchanged (idempotent)', async () => {
    const out = await sparsifyAssignmentPermissions({
      db: fakeDb(),
      assignments: [{ location_id: 'loc1', role: 'staff', permissions: { email: true } }],
    })
    expect(out[0].permissions).toEqual({ email: true })
  })
})
