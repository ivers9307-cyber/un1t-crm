import { describe, it, expect } from 'vitest'
import { STAGE_ROLES, stageRoleOf, isLiveFunnelRole, isPileRole, roleConfigError } from './stage-roles.js'

describe('stage roles', () => {
  it('stageRoleOfPrefersStoredRole', () => {
    expect(stageRoleOf({ stage_role: 'checkpoint', is_dormant: true })).toBe('checkpoint')
    expect(stageRoleOf({ stage_role: 'nonsense' })).toBe('custom')
  })
  it('stageRoleOfFallsBackToDormant', () => {
    expect(stageRoleOf({ stage_role: null, is_dormant: true })).toBe('pile')
    expect(stageRoleOf({ is_dormant: false })).toBe('custom')
    expect(STAGE_ROLES).toContain('pile')
  })
  it('liveFunnelRoles', () => {
    for (const r of ['new', 'first_class', 'class_n', 'checkpoint', 'done']) expect(isLiveFunnelRole(r)).toBe(true)
    for (const r of ['converted', 'pile', 'custom']) expect(isLiveFunnelRole(r)).toBe(false)
    expect(isPileRole('pile')).toBe(true)
    expect(isPileRole('done')).toBe(false)
  })
  it('roleConfigValidation', () => {
    expect(roleConfigError('class_n', { count: 1 })).toBeTruthy()
    expect(roleConfigError('class_n', { count: 3 })).toBeNull()
    expect(roleConfigError('checkpoint', { day: 0 })).toBeTruthy()
    expect(roleConfigError('checkpoint', { day: 7 })).toBeNull()
    expect(roleConfigError('done', {})).toBeNull()
  })
})
