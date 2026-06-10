import { describe, it, expect } from 'vitest'
import { buildStaffProfilePatch, computeProfileRole, assertOwnerAssignmentScope, computeDesiredAssignments } from './staff-write.js'

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
