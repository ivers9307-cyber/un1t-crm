import { describe, it, expect } from 'vitest'
import { buildStaffProfilePatch, computeProfileRole } from './staff-write.js'

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
