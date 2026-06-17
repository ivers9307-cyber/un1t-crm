import { describe, it, expect } from 'vitest'
import { TIME_OFF_TYPES, timeOffTypesFor, defaultTimeOffTypeFor, timeOffTypeLabel } from './time-off'

describe('time-off catalogue + gating', () => {
  it('lists all five types with labels', () => {
    expect(TIME_OFF_TYPES.map(t => t.value)).toEqual(['holiday', 'sick', 'unpaid', 'other', 'unavailable'])
    expect(TIME_OFF_TYPES.every(t => typeof t.label === 'string' && t.label.length > 0)).toBe(true)
  })

  it('gives full-time employees the four leave types', () => {
    expect(timeOffTypesFor('fte').map(t => t.value)).toEqual(['holiday', 'sick', 'unpaid', 'other'])
    expect(defaultTimeOffTypeFor('fte')).toBe('holiday')
  })

  it('restricts contractors + casual to unavailable only', () => {
    for (const et of ['contractor', 'casual']) {
      expect(timeOffTypesFor(et).map(t => t.value)).toEqual(['unavailable'])
      expect(defaultTimeOffTypeFor(et)).toBe('unavailable')
    }
  })

  it('defaults unknown/null employment to the full leave menu (does not over-restrict)', () => {
    expect(timeOffTypesFor(null).map(t => t.value)).toEqual(['holiday', 'sick', 'unpaid', 'other'])
    expect(timeOffTypesFor(undefined).map(t => t.value)).toEqual(['holiday', 'sick', 'unpaid', 'other'])
    expect(defaultTimeOffTypeFor(null)).toBe('holiday')
  })

  it('labels a type value', () => {
    expect(timeOffTypeLabel('unavailable')).toBe('Unavailable')
    expect(timeOffTypeLabel('nope')).toBe('nope') // fallback to the raw value
  })
})
