import { describe, it, expect } from 'vitest'
import {
  TIME_OFF_TYPES, timeOffTypesFor, defaultTimeOffTypeFor, timeOffTypeLabel,
  isTimeOffTypeAllowedFor, timeOffLeaveLabel, isExpiredPendingRequest, effectiveTimeOffStatus, leaveClashLabel,
  leaveClashPrompt, leaveDateRangeLabel, leavePreviewLine,
  isRequestableTimeOffType, canRequestTimeOff, UNAVAILABLE_MOVED_ERROR, RESTRICTED_TYPE_ERROR,
  CONTRACTOR_DECIDE_ERROR, AVAILABILITY_INSTEAD,
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

  it('AVAIL.3 — contractors + casual have nothing to request: no types, no default', () => {
    for (const et of ['contractor', 'casual']) {
      expect(timeOffTypesFor(et)).toEqual([])
      expect(defaultTimeOffTypeFor(et)).toBeNull()
      expect(canRequestTimeOff(et)).toBe(false)
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

describe('leaveDateRangeLabel', () => {
  it('one day reads as one day, a range as a range', () => {
    expect(leaveDateRangeLabel('2026-10-05', '2026-10-05')).toBe('Mon 5 Oct')
    expect(leaveDateRangeLabel('2026-10-05', '2026-10-09')).toBe('Mon 5 Oct – Fri 9 Oct')
  })
  it('a missing end is the start; a range across a year end names both years', () => {
    expect(leaveDateRangeLabel('2026-10-05', null)).toBe('Mon 5 Oct')
    expect(leaveDateRangeLabel('2026-12-30', '2027-01-02')).toBe('Wed 30 Dec 2026 – Sat 2 Jan 2027')
  })
  it('no start is an empty label, never "undefined"', () => {
    expect(leaveDateRangeLabel(null, null)).toBe('')
  })
})

describe('leavePreviewLine', () => {
  it('date, effective start–end, template, studio', () => {
    expect(leavePreviewLine({
      block_date: '2026-10-05', start_time: '06:00:00', end_time: '09:00:00',
      template_name: 'Morning', location_name: 'Studio One',
    })).toBe('Mon 5 Oct · 06:00–09:00 · Morning · Studio One')
  })
  it('leaves out whatever is missing rather than printing "null"', () => {
    expect(leavePreviewLine({ block_date: '2026-10-05', start_time: '06:00:00' })).toBe('Mon 5 Oct · 06:00')
    expect(leavePreviewLine({ block_date: '2026-10-05' })).toBe('Mon 5 Oct')
  })
})

// AVAIL.3 — "unavailable" moved into availability (mig 631).
describe('AVAIL.3 — unavailable is no longer requested', () => {
  it('no employment type is offered unavailable, and employees keep their four types', () => {
    for (const et of ['fte', 'contractor', 'casual', null, undefined, 'weird']) {
      expect(timeOffTypesFor(et).map((t) => t.value)).not.toContain('unavailable')
    }
    expect(timeOffTypesFor('fte').map((t) => t.value)).toEqual(['holiday', 'sick', 'unpaid', 'other'])
    expect(canRequestTimeOff('fte')).toBe(true)
    expect(canRequestTimeOff(null)).toBe(true)
  })

  it('isRequestableTimeOffType refuses unavailable only', () => {
    expect(isRequestableTimeOffType('unavailable')).toBe(false)
    for (const t of ['holiday', 'sick', 'unpaid', 'other']) expect(isRequestableTimeOffType(t)).toBe(true)
  })

  it('history keeps its label: the catalogue, the leave label and the decision gate are unchanged', () => {
    expect(TIME_OFF_TYPES.map((t) => t.value)).toContain('unavailable')
    expect(timeOffTypeLabel('unavailable')).toBe('Unavailable')
    expect(timeOffLeaveLabel('unavailable')).toBe('Unavailable')
    // Deciding a pending unavailable request still works for a contractor.
    expect(isTimeOffTypeAllowedFor('contractor', 'unavailable')).toBe(true)
    expect(isTimeOffTypeAllowedFor('contractor', 'holiday')).toBe(false)
  })

  it('every message names My availability; none tells anyone to file Unavailable', () => {
    expect(UNAVAILABLE_MOVED_ERROR).toMatch(/^Unavailable is no longer a time-off request\./)
    expect(UNAVAILABLE_MOVED_ERROR).toMatch(/My availability/)
    expect(UNAVAILABLE_MOVED_ERROR).toMatch(/No approval is needed/)
    expect(RESTRICTED_TYPE_ERROR).toMatch(/^Contractors.*My availability/)
    expect(CONTRACTOR_DECIDE_ERROR).toMatch(/^Contractors don’t take leave\. Decline this request/)
    expect(CONTRACTOR_DECIDE_ERROR).not.toMatch(/file it as Unavailable/)
    expect(AVAILABILITY_INSTEAD).toEqual({
      title: 'Use My availability instead',
      message: expect.stringMatching(/My availability/),
      action: 'Open My availability',
      onBehalf: expect.stringMatching(/^Contractors don’t take leave, so there is nothing to record here/),
    })
  })

  it('no em dashes in any of the words (staff copy follows the customer-copy rule)', () => {
    for (const s of [UNAVAILABLE_MOVED_ERROR, RESTRICTED_TYPE_ERROR, CONTRACTOR_DECIDE_ERROR, ...Object.values(AVAILABILITY_INSTEAD)]) {
      expect(s).not.toMatch(/—/)
    }
  })
})
