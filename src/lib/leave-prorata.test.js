import { describe, it, expect } from 'vitest'
import { employedDaysInYear, proratedEntitlementDays, roundToHalfDay, yearsTouchedByDates } from './leave-prorata.js'

describe('employedDaysInYear', () => {
  it('is the whole year with no dates', () => {
    expect(employedDaysInYear(2026, null, null)).toEqual({ employed: 365, length: 365 })
    expect(employedDaysInYear(2028, null, null)).toEqual({ employed: 366, length: 366 })
  })
  it('counts start and end inclusive', () => {
    // 1 Sep – 14 Dec 2026: 30 + 31 + 30 + 14
    expect(employedDaysInYear(2026, '2026-09-01', '2026-12-14').employed).toBe(105)
    expect(employedDaysInYear(2026, '2026-12-31', null).employed).toBe(1)
  })
  it('is 0 for a year outside the employment', () => {
    expect(employedDaysInYear(2026, '2027-01-05', null).employed).toBe(0)
    expect(employedDaysInYear(2027, '2026-09-01', '2026-12-14').employed).toBe(0)
  })
  it('treats an unreadable date as open', () => {
    expect(employedDaysInYear(2026, 'soon', '').employed).toBe(365)
  })
})

describe('proratedEntitlementDays', () => {
  it('leaves a whole year untouched, even an odd entitlement', () => {
    expect(proratedEntitlementDays(20, 2026, null, null)).toBe(20)
    expect(proratedEntitlementDays(21.3, 2026, '2025-03-01', null)).toBe(21.3)
  })
  it('pro-rates a starter and leaver to the nearest half day', () => {
    // 20 × 105 / 365 = 5.75 → 6
    expect(proratedEntitlementDays(20, 2026, '2026-09-01', '2026-12-14')).toBe(6)
    // 20 × 122 / 365 = 6.68 → 6.5
    expect(proratedEntitlementDays(20, 2026, '2026-09-01', null)).toBe(6.5)
    // 20 × 181 / 365 = 9.92 → 10 (left 30 Jun)
    expect(proratedEntitlementDays(20, 2026, null, '2026-06-30')).toBe(10)
  })
  it('is 0 for a year not worked', () => {
    expect(proratedEntitlementDays(20, 2026, '2027-02-01', null)).toBe(0)
  })
  it('passes through a 0 or unreadable entitlement unchanged', () => {
    expect(proratedEntitlementDays(0, 2026, '2026-09-01', null)).toBe(0)
    expect(Number.isNaN(proratedEntitlementDays(Number.NaN, 2026, '2026-09-01', null))).toBe(true)
  })
})

describe('roundToHalfDay', () => {
  it('rounds halves up', () => {
    expect(roundToHalfDay(5.25)).toBe(5.5)
    expect(roundToHalfDay(5.2)).toBe(5)
    expect(roundToHalfDay(5.75)).toBe(6)
  })
})

describe('yearsTouchedByDates', () => {
  it('collects every year the old and new dates fall in, plus this year', () => {
    expect(yearsTouchedByDates([{ start: '2025-11-01', end: null }, { start: '2025-11-01', end: '2027-01-10' }], 2026))
      .toEqual([2025, 2026, 2027])
  })
})
