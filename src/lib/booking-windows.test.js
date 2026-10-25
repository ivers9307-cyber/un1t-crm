import { describe, it, expect } from 'vitest'
import { dayWindows, dayHasWindows, windowsIssue, availabilityIssue, formatWindows } from './booking-windows'

describe('dayWindows', () => {
  it('reads the legacy single-window shape as a one-window list', () => {
    expect(dayWindows({ mon: { start: '09:00', end: '18:00' } }, 'mon'))
      .toEqual([{ start: '09:00', end: '18:00' }])
  })

  it('reads the list shape, sorted by start', () => {
    const availability = { mon: [{ start: '17:00', end: '20:00' }, { start: '07:00', end: '10:00' }] }
    expect(dayWindows(availability, 'mon')).toEqual([
      { start: '07:00', end: '10:00' },
      { start: '17:00', end: '20:00' },
    ])
  })

  it('trims HH:MM:SS to HH:MM', () => {
    expect(dayWindows({ tue: [{ start: '09:00:00', end: '12:30:00' }] }, 'tue'))
      .toEqual([{ start: '09:00', end: '12:30' }])
  })

  it("keeps '24:00' as an end of day", () => {
    expect(dayWindows({ fri: { start: '23:00', end: '24:00' } }, 'fri')).toEqual([{ start: '23:00', end: '24:00' }])
    expect(dayWindows({ fri: { start: '24:00', end: '24:00' } }, 'fri')).toEqual([])
  })

  it('a day that is off, missing, or junk has no windows', () => {
    expect(dayWindows({ mon: null }, 'mon')).toEqual([])
    expect(dayWindows({}, 'mon')).toEqual([])
    expect(dayWindows(null, 'mon')).toEqual([])
    expect(dayWindows({ mon: [] }, 'mon')).toEqual([])
    expect(dayWindows({ mon: 'yes' }, 'mon')).toEqual([])
    expect(dayWindows({ mon: { start: null, end: null } }, 'mon')).toEqual([])
  })

  it('drops malformed or empty windows and keeps the good ones', () => {
    const availability = { mon: [
      { start: '09:00', end: '09:00' },
      { start: '12:00', end: '10:00' },
      { start: 'nine', end: '10:00' },
      null,
      { start: '14:00', end: '15:00' },
    ] }
    expect(dayWindows(availability, 'mon')).toEqual([{ start: '14:00', end: '15:00' }])
  })
})

describe('dayHasWindows', () => {
  it('an empty list is not an open day (an array is truthy)', () => {
    expect(dayHasWindows({ mon: [] }, 'mon')).toBe(false)
    expect(dayHasWindows({ mon: [{ start: '09:00', end: '10:00' }] }, 'mon')).toBe(true)
    expect(dayHasWindows({ mon: { start: '09:00', end: '10:00' } }, 'mon')).toBe(true)
  })
})

describe('windowsIssue', () => {
  it('passes non-overlapping windows, including ones that touch', () => {
    expect(windowsIssue([{ start: '07:00', end: '10:00' }, { start: '10:00', end: '12:00' }])).toBeNull()
  })

  it('refuses an end that is not after the start', () => {
    expect(windowsIssue([{ start: '10:00', end: '10:00' }])).toMatch(/end after it starts/)
    expect(windowsIssue([{ start: '11:00', end: '10:00' }])).toMatch(/end after it starts/)
  })

  it('refuses overlapping windows, in any order', () => {
    expect(windowsIssue([{ start: '12:00', end: '14:00' }, { start: '09:00', end: '12:30' }]))
      .toMatch(/09:00–12:30 overlaps 12:00–14:00/)
  })

  it('refuses a missing time', () => {
    expect(windowsIssue([{ start: '', end: '10:00' }])).toMatch(/start and an end/)
  })
})

describe('availabilityIssue', () => {
  it('accepts null, legacy objects, lists and off days', () => {
    expect(availabilityIssue(null)).toBeNull()
    expect(availabilityIssue({
      mon: { start: '09:00', end: '18:00' },
      tue: [{ start: '07:00', end: '10:00' }, { start: '17:00', end: '20:00' }],
      wed: null,
      thu: [],
    })).toBeNull()
  })

  it('names the day with the problem', () => {
    expect(availabilityIssue({ wed: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }] }))
      .toMatch(/^Wednesday: /)
    expect(availabilityIssue({ fri: { start: '18:00', end: '09:00' } })).toMatch(/^Friday: /)
  })

  it('refuses unknown day keys and non-object shapes', () => {
    expect(availabilityIssue({ funday: null })).toMatch(/funday/)
    expect(availabilityIssue([])).toMatch(/object/)
    expect(availabilityIssue({ mon: 'open' })).toMatch(/^Monday: /)
  })
})

describe('formatWindows', () => {
  it('joins windows for display', () => {
    expect(formatWindows([{ start: '09:00', end: '12:00' }, { start: '17:00', end: '20:00' }]))
      .toBe('09:00–12:00, 17:00–20:00')
    expect(formatWindows([])).toBe('')
  })
})
