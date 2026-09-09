import { describe, it, expect } from 'vitest'
import { countLeaveDays, splitAtYearEnd, rangesOverlap } from './time-off-days'

describe('countLeaveDays', () => {
  it('counts Mon-Fri only for holiday', () => {
    // 2026-06-01 (Mon) → 2026-06-07 (Sun) = 5 working days
    expect(countLeaveDays('holiday', '2026-06-01', '2026-06-07')).toBe(5)
  })
  it('counts every calendar day for non-holiday types', () => {
    expect(countLeaveDays('sick', '2026-06-01', '2026-06-07')).toBe(7)
  })
  it('a weekend-only holiday is 0 days', () => {
    expect(countLeaveDays('holiday', '2026-06-06', '2026-06-07')).toBe(0)
  })
})
describe('splitAtYearEnd', () => {
  it('returns one range inside a year', () => {
    expect(splitAtYearEnd('2026-06-01', '2026-06-03')).toEqual([['2026-06-01', '2026-06-03']])
  })
  it('splits a range straddling 31 Dec', () => {
    expect(splitAtYearEnd('2026-12-30', '2027-01-02')).toEqual([['2026-12-30', '2026-12-31'], ['2027-01-01', '2027-01-02']])
  })
})
describe('rangesOverlap', () => {
  it('inclusive overlap', () => {
    expect(rangesOverlap('2026-06-01', '2026-06-03', '2026-06-03', '2026-06-05')).toBe(true)
    expect(rangesOverlap('2026-06-01', '2026-06-03', '2026-06-04', '2026-06-05')).toBe(false)
  })
})
