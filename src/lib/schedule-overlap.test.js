// SCHEDULE-DOUBLE-BOOKING.1 — unit tests for the overlap helpers.
import { describe, it, expect } from 'vitest'
import { fmtTime, formatTime12h, timeRangesOverlap } from './schedule-overlap'

describe('fmtTime', () => {
  it('trims HH:MM:SS to HH:MM', () => {
    expect(fmtTime('09:30:00')).toBe('09:30')
    expect(fmtTime('17:00')).toBe('17:00')
  })
  it('handles null/empty', () => {
    expect(fmtTime(null)).toBe('')
    expect(fmtTime(undefined)).toBe('')
  })
})

describe('timeRangesOverlap', () => {
  it('detects a genuine overlap', () => {
    expect(timeRangesOverlap('09:00:00', '10:00:00', '09:30:00', '10:30:00')).toBe(true)
  })
  it('detects full containment', () => {
    expect(timeRangesOverlap('09:00', '12:00', '10:00', '11:00')).toBe(true)
    expect(timeRangesOverlap('10:00', '11:00', '09:00', '12:00')).toBe(true)
  })
  it('identical ranges overlap', () => {
    expect(timeRangesOverlap('09:30', '10:30', '09:30', '10:30')).toBe(true)
  })
  it('touching endpoints do NOT count as overlap', () => {
    // a ends exactly when b starts
    expect(timeRangesOverlap('09:00', '10:00', '10:00', '11:00')).toBe(false)
    expect(timeRangesOverlap('10:00', '11:00', '09:00', '10:00')).toBe(false)
  })
  it('disjoint ranges do not overlap', () => {
    expect(timeRangesOverlap('09:00', '10:00', '14:00', '15:00')).toBe(false)
  })
  it('ignores sub-minute precision (minute granularity)', () => {
    // These overlap only in the seconds (10:00:10 < 10:00:45); at minute
    // granularity they merely touch, so no overlap is reported.
    expect(timeRangesOverlap('09:00:00', '10:00:45', '10:00:10', '11:00:00')).toBe(false)
    // A genuine minute-level overlap is still detected regardless of seconds.
    expect(timeRangesOverlap('09:00:30', '10:00:30', '09:30:00', '10:30:00')).toBe(true)
  })
  it('returns false for missing inputs', () => {
    expect(timeRangesOverlap('', '10:00', '09:30', '10:30')).toBe(false)
    expect(timeRangesOverlap('09:00', '10:00', null, '10:30')).toBe(false)
  })
  it('returns false for zero-length or overnight ranges (out of scope)', () => {
    expect(timeRangesOverlap('10:00', '10:00', '09:00', '11:00')).toBe(false) // zero-length
    expect(timeRangesOverlap('22:00', '06:00', '23:00', '23:30')).toBe(false) // overnight a
  })
})

// ROSTER-FIX.6c — the 12-hour label three schedule screens each had their own
// copy of. Pinned here because it is now shared: a change to it moves the
// calendar, the template manager and the swap list at once.
describe('formatTime12h', () => {
  it('drops :00 minutes', () => {
    expect(formatTime12h('09:00:00')).toBe('9am')
    expect(formatTime12h('17:00')).toBe('5pm')
  })
  it('keeps non-zero minutes', () => {
    expect(formatTime12h('09:30:00')).toBe('9:30am')
    expect(formatTime12h('18:45')).toBe('6:45pm')
  })
  it('midnight is 12am and noon is 12pm', () => {
    expect(formatTime12h('00:00')).toBe('12am')
    expect(formatTime12h('12:00')).toBe('12pm')
    expect(formatTime12h('00:15')).toBe('12:15am')
  })
  it('returns empty for a missing time', () => {
    expect(formatTime12h(null)).toBe('')
    expect(formatTime12h('')).toBe('')
    expect(formatTime12h(undefined)).toBe('')
  })
})
