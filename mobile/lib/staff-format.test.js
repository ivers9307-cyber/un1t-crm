import { describe, it, expect } from 'vitest'
import { formatRole, formatEmploymentType } from './staff-format.js'

describe('formatRole', () => {
  it('humanises every known role', () => {
    expect(formatRole('master')).toBe('Master')
    expect(formatRole('owner')).toBe('Owner')
    expect(formatRole('manager')).toBe('Manager')
    expect(formatRole('head_coach')).toBe('Head Coach')
    expect(formatRole('staff')).toBe('Staff')
  })
  it('falls back to the raw value for an unknown role, em-dash for empty', () => {
    expect(formatRole('regional_lead')).toBe('regional_lead')
    expect(formatRole(null)).toBe('—')
    expect(formatRole(undefined)).toBe('—')
    expect(formatRole('')).toBe('—')
  })
})

describe('formatEmploymentType', () => {
  it('humanises every known type', () => {
    expect(formatEmploymentType('fte')).toBe('Full-time')
    expect(formatEmploymentType('contractor')).toBe('Contractor')
    expect(formatEmploymentType('casual')).toBe('Casual')
  })
  it('falls back to the raw value for unknown, em-dash for empty', () => {
    expect(formatEmploymentType('intern')).toBe('intern')
    expect(formatEmploymentType(null)).toBe('—')
    expect(formatEmploymentType(undefined)).toBe('—')
  })
})
