import { describe, it, expect } from 'vitest'
import { buildStaffProfilePatch, computeProfileRole, assertOwnerAssignmentScope } from './staff-write.js'

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
