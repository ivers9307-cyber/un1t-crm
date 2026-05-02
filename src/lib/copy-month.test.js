// Tests for the copy-month helpers (mapDayOfMonth + daysInMonth).
// These pin the day-of-month skip behaviour for short target months
// (Jan 31 -> Feb has no day 31) and the leap-year branch (Feb 29
// only exists when leap).

import { describe, it, expect } from 'vitest'
import { daysInMonth, mapDayOfMonth } from '../app/api/schedule/shifts/copy-month/route.js'

describe('daysInMonth', () => {
  it('handles 31-day months', () => {
    expect(daysInMonth('2025-01-01')).toBe(31)
    expect(daysInMonth('2025-03-01')).toBe(31)
    expect(daysInMonth('2025-05-01')).toBe(31)
    expect(daysInMonth('2025-07-01')).toBe(31)
    expect(daysInMonth('2025-08-01')).toBe(31)
    expect(daysInMonth('2025-10-01')).toBe(31)
    expect(daysInMonth('2025-12-01')).toBe(31)
  })

  it('handles 30-day months', () => {
    expect(daysInMonth('2025-04-01')).toBe(30)
    expect(daysInMonth('2025-06-01')).toBe(30)
    expect(daysInMonth('2025-09-01')).toBe(30)
    expect(daysInMonth('2025-11-01')).toBe(30)
  })

  it('handles February in non-leap years', () => {
    expect(daysInMonth('2025-02-01')).toBe(28)
    expect(daysInMonth('2026-02-01')).toBe(28)
    expect(daysInMonth('2027-02-01')).toBe(28)
  })

  it('handles February in leap years', () => {
    expect(daysInMonth('2024-02-01')).toBe(29)
    expect(daysInMonth('2028-02-01')).toBe(29)
    expect(daysInMonth('2000-02-01')).toBe(29) // century-divisible-by-400 rule
  })

  it('handles century non-leap years (1900, 2100)', () => {
    expect(daysInMonth('1900-02-01')).toBe(28)
    expect(daysInMonth('2100-02-01')).toBe(28)
  })

  it('is independent of the day-of-month in the input', () => {
    // The implementation only reads year + month from the ISO date,
    // so passing any day in the month must give the same answer.
    expect(daysInMonth('2025-03-15')).toBe(31)
    expect(daysInMonth('2024-02-28')).toBe(29)
  })
})

describe('mapDayOfMonth', () => {
  it('maps within a 31-day target', () => {
    // Source: Jan 5; target: March (31 days) -> March 5.
    expect(mapDayOfMonth('2025-01-05', '2025-03-01')).toBe('2025-03-05')
    // Edge: Jan 31 -> March 31 (both have 31 days).
    expect(mapDayOfMonth('2025-01-31', '2025-03-01')).toBe('2025-03-31')
  })

  it('skips Jan 30 / 31 when target is non-leap February', () => {
    expect(mapDayOfMonth('2025-01-30', '2025-02-01')).toBeNull()
    expect(mapDayOfMonth('2025-01-31', '2025-02-01')).toBeNull()
  })

  it('skips Jan 30 only (not 29) when target is leap February', () => {
    expect(mapDayOfMonth('2025-01-29', '2024-02-01')).toBe('2024-02-29')
    expect(mapDayOfMonth('2025-01-30', '2024-02-01')).toBeNull()
    expect(mapDayOfMonth('2025-01-31', '2024-02-01')).toBeNull()
  })

  it('skips March 31 when target is April (30 days)', () => {
    expect(mapDayOfMonth('2025-03-31', '2025-04-01')).toBeNull()
    expect(mapDayOfMonth('2025-03-30', '2025-04-01')).toBe('2025-04-30')
  })

  it('preserves day-1 across any month transition', () => {
    expect(mapDayOfMonth('2025-01-01', '2025-02-01')).toBe('2025-02-01')
    expect(mapDayOfMonth('2025-02-01', '2025-03-01')).toBe('2025-03-01')
    expect(mapDayOfMonth('2024-12-01', '2025-01-01')).toBe('2025-01-01')
  })

  it('crosses years cleanly (Dec -> Jan)', () => {
    expect(mapDayOfMonth('2024-12-15', '2025-01-01')).toBe('2025-01-15')
    expect(mapDayOfMonth('2024-12-31', '2025-01-01')).toBe('2025-01-31')
  })
})
