import { describe, it, expect } from 'vitest'
import {
  TIME_OFF_TYPES, timeOffTypesFor, defaultTimeOffTypeFor, timeOffTypeLabel,
  isTimeOffTypeAllowedFor, timeOffLeaveLabel, isExpiredPendingRequest, effectiveTimeOffStatus, leaveClashLabel,
  leaveClashPrompt,
} from './time-off'

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

// LEAVE.2
describe('LEAVE.2 helpers', () => {
  it('isTimeOffTypeAllowedFor: contractors only unavailable; FTE/unknown unrestricted', () => {
    for (const t of ['holiday', 'sick', 'unpaid', 'other']) expect(isTimeOffTypeAllowedFor('contractor', t)).toBe(false)
    expect(isTimeOffTypeAllowedFor('contractor', 'unavailable')).toBe(true)
    for (const t of ['holiday', 'sick', 'unpaid', 'other', 'unavailable']) {
      expect(isTimeOffTypeAllowedFor('fte', t)).toBe(true)
      expect(isTimeOffTypeAllowedFor(null, t)).toBe(true)
    }
  })

  it('timeOffLeaveLabel names every type; unpaid and other are not "Unavailable"', () => {
    expect(timeOffLeaveLabel('unpaid')).toBe('Unpaid leave')
    expect(timeOffLeaveLabel('other')).toBe('Other leave')
    expect(timeOffLeaveLabel('sick')).toBe('Sick leave')
    expect(timeOffLeaveLabel('unavailable')).toBe('Unavailable')
    expect(timeOffLeaveLabel('weird')).toBe('Time off')
  })

  it('a pending request expires the day after its end_date; nothing else expires', () => {
    const r = { status: 'pending', end_date: '2026-08-30' }
    expect(isExpiredPendingRequest(r, '2026-08-30')).toBe(false)
    expect(isExpiredPendingRequest(r, '2026-08-31')).toBe(true)
    expect(isExpiredPendingRequest({ ...r, status: 'approved' }, '2026-09-17')).toBe(false)
    expect(effectiveTimeOffStatus(r, '2026-09-17')).toBe('expired')
    expect(effectiveTimeOffStatus({ ...r, status: 'rejected' }, '2026-09-17')).toBe('rejected')
  })

  it('leaveClashLabel', () => {
    expect(leaveClashLabel(0)).toBeNull()
    expect(leaveClashLabel(undefined)).toBeNull()
    expect(leaveClashLabel(1)).toBe('Clashes with 1 rostered shift')
    expect(leaveClashLabel(3)).toBe('Clashes with 3 rostered shifts')
  })
})

describe('leaveClashPrompt', () => {
  it('null when there is nothing to ask', () => {
    expect(leaveClashPrompt([])).toBeNull()
    expect(leaveClashPrompt(undefined)).toBeNull()
  })
  it('titles with the count, lists the shifts and returns their ids', () => {
    const p = leaveClashPrompt([
      { id: 'a1', block_date: '2026-09-18', start_time: '06:30:00', template_name: 'AM', location_name: 'Stillorgan' },
      { id: 'a2', block_date: '2026-09-19' },
    ])
    expect(p.title).toBe('Clashes with 2 rostered shifts')
    expect(p.message).toContain('Fri 18 Sep 06:30 AM (Stillorgan)')
    expect(p.message).toContain('Sat 19 Sep')
    expect(p.assignmentIds).toEqual(['a1', 'a2'])
  })
  it('caps the list at six lines', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, block_date: '2026-09-18' }))
    expect(leaveClashPrompt(many).message).toContain('and 2 more')
    expect(leaveClashPrompt(many).assignmentIds).toHaveLength(8)
  })
})
