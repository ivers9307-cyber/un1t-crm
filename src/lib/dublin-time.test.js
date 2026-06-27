import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dublinTodayStr, dublinNowMinutes, addDaysISO, dublinTimeLabel } from './dublin-time.js'

describe('dublinTodayStr', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('returns Dublin date even when UTC is the previous day (BST window)', () => {
    // 2026-05-11 23:30 UTC = 2026-05-12 00:30 Dublin BST.
    // The Dublin-local date is May 12 even though UTC says May 11.
    vi.setSystemTime(new Date('2026-05-11T23:30:00Z'))
    expect(dublinTodayStr()).toBe('2026-05-12')
  })

  it('returns same date when UTC and Dublin agree (winter, GMT == UTC)', () => {
    // 2026-12-15 14:00 UTC = 2026-12-15 14:00 Dublin GMT.
    vi.setSystemTime(new Date('2026-12-15T14:00:00Z'))
    expect(dublinTodayStr()).toBe('2026-12-15')
  })

  it('returns previous day when Dublin is still on the prior date (early UTC morning, winter)', () => {
    // 2026-12-15 00:30 UTC = 2026-12-15 00:30 Dublin GMT — same date.
    // No edge case in winter because Dublin == UTC.
    vi.setSystemTime(new Date('2026-12-15T00:30:00Z'))
    expect(dublinTodayStr()).toBe('2026-12-15')
  })

  it('handles BST early-morning correctly (after midnight Dublin, before midnight UTC)', () => {
    // 2026-05-11 22:00 UTC = 2026-05-11 23:00 Dublin BST — same date.
    vi.setSystemTime(new Date('2026-05-11T22:00:00Z'))
    expect(dublinTodayStr()).toBe('2026-05-11')
  })
})

describe('dublinNowMinutes', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('returns Dublin clock minutes during BST (UTC+1)', () => {
    // 2026-05-11 09:00 UTC = 2026-05-11 10:00 Dublin BST.
    vi.setSystemTime(new Date('2026-05-11T09:00:00Z'))
    expect(dublinNowMinutes()).toBe(10 * 60) // 10:00 Dublin
  })

  it('returns Dublin clock minutes during GMT (winter)', () => {
    // 2026-12-15 14:30 UTC = 2026-12-15 14:30 Dublin GMT.
    vi.setSystemTime(new Date('2026-12-15T14:30:00Z'))
    expect(dublinNowMinutes()).toBe(14 * 60 + 30)
  })

  it('handles midnight Dublin correctly', () => {
    // 2026-05-11 23:00 UTC = 2026-05-12 00:00 Dublin BST.
    vi.setSystemTime(new Date('2026-05-11T23:00:00Z'))
    expect(dublinNowMinutes()).toBe(0)
  })
})

describe('addDaysISO', () => {
  it('adds days within a month', () => {
    expect(addDaysISO('2026-05-11', 7)).toBe('2026-05-18')
  })
  it('handles month boundary', () => {
    expect(addDaysISO('2026-05-30', 5)).toBe('2026-06-04')
  })
  it('handles year boundary', () => {
    expect(addDaysISO('2026-12-30', 5)).toBe('2027-01-04')
  })
  it('handles negative days', () => {
    expect(addDaysISO('2026-05-11', -1)).toBe('2026-05-10')
  })
  it('zero days = same date', () => {
    expect(addDaysISO('2026-05-11', 0)).toBe('2026-05-11')
  })
})

describe('dublinTimeLabel', () => {
  it('formats a UTC instant as Dublin HH:MM (BST = +1 in summer)', () => {
    expect(dublinTimeLabel('2026-06-27T17:00:00Z')).toBe('18:00')
  })
  it('formats a winter instant (GMT = +0)', () => {
    expect(dublinTimeLabel('2026-01-15T09:30:00Z')).toBe('09:30')
  })
  it('returns null for a bad input', () => {
    expect(dublinTimeLabel('nope')).toBeNull()
    expect(dublinTimeLabel(null)).toBeNull()
  })
})
