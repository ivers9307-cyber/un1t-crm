// NOTIF.4 — tests for parseIsoDate, the guard that turns `?date=` route
// params (fed by push payloads) into a local-time Date. Pure (no RN
// imports), runs under the root vitest like the other mobile/lib tests.
//
// ROSTER-FIX.7 — extended to isoDate, weekStart and dublinTodayIso. This file
// runs under whatever TZ the machine happens to be on; the pair
// dates.tz.test.js / dates.tz-dublin.test.js pin the two that matter.

import { describe, it, expect } from 'vitest'
import { parseIsoDate, isoDate, weekStart, dublinTodayIso } from './dates'

describe('parseIsoDate', () => {
  it('parses a valid YYYY-MM-DD into a local-time midnight Date', () => {
    const d = parseIsoDate('2026-07-10')
    expect(d).toBeInstanceOf(Date)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(6)
    expect(d.getDate()).toBe(10)
    expect(d.getHours()).toBe(0)
    // Round-trips through the local formatter (i.e. no UTC day-shift).
    expect(isoDate(d)).toBe('2026-07-10')
  })

  it('rejects malformed or non-string input', () => {
    expect(parseIsoDate('next week')).toBe(null)
    expect(parseIsoDate('2026-7-1')).toBe(null)
    expect(parseIsoDate('2026-07-10T00:00:00Z')).toBe(null)
    expect(parseIsoDate('')).toBe(null)
    expect(parseIsoDate(null)).toBe(null)
    expect(parseIsoDate(undefined)).toBe(null)
    expect(parseIsoDate(20260710)).toBe(null)
    expect(parseIsoDate(['2026-07-10'])).toBe(null)
  })

  it('rejects impossible calendar dates (no silent rollover)', () => {
    expect(parseIsoDate('2026-02-31')).toBe(null)
    expect(parseIsoDate('2026-13-01')).toBe(null)
    expect(parseIsoDate('2026-00-10')).toBe(null)
  })
})

describe('isoDate', () => {
  it('formats a local-time Date as YYYY-MM-DD with zero padding', () => {
    expect(isoDate(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(isoDate(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('reads the LOCAL day, never the UTC one', () => {
    // 23:30 local on the 5th is the 6th in UTC in Dublin summer / anywhere
    // east of it; the shift_date this pairs with is a local wall-clock date.
    const d = new Date(2026, 6, 5, 23, 30)
    expect(isoDate(d)).toBe('2026-07-05')
    expect(isoDate(d)).toBe(`2026-07-0${d.getDate()}`)
  })

  it('round-trips with parseIsoDate', () => {
    for (const iso of ['2026-01-01', '2026-02-28', '2026-06-15', '2026-12-31']) {
      expect(isoDate(parseIsoDate(iso))).toBe(iso)
    }
  })
})

describe('weekStart', () => {
  it('returns the Monday of the containing week (Monday-first grid)', () => {
    // 2026-09-09 is a Wednesday.
    expect(isoDate(weekStart(new Date(2026, 8, 9)))).toBe('2026-09-07')
  })

  it('treats Sunday as the END of its week, not the start', () => {
    // 2026-09-13 is a Sunday — it belongs to the week beginning the 7th.
    expect(isoDate(weekStart(new Date(2026, 8, 13)))).toBe('2026-09-07')
    // …and Monday the 14th starts the next one.
    expect(isoDate(weekStart(new Date(2026, 8, 14)))).toBe('2026-09-14')
  })

  it('is idempotent and normalises the time to local midnight', () => {
    const w = weekStart(new Date(2026, 8, 9, 17, 45, 12))
    expect(w.getHours()).toBe(0)
    expect(w.getMinutes()).toBe(0)
    expect(isoDate(weekStart(w))).toBe(isoDate(w))
  })

  it('does not mutate the Date it was handed', () => {
    const input = new Date(2026, 8, 9, 17, 45)
    const before = input.getTime()
    weekStart(input)
    expect(input.getTime()).toBe(before)
  })

  it('crosses a month and a year boundary correctly', () => {
    expect(isoDate(weekStart(new Date(2026, 8, 1)))).toBe('2026-08-31')
    expect(isoDate(weekStart(new Date(2027, 0, 1)))).toBe('2026-12-28')
  })
})

describe('dublinTodayIso', () => {
  it('returns a YYYY-MM-DD string', () => {
    expect(dublinTodayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('is parseable as a real calendar date', () => {
    expect(parseIsoDate(dublinTodayIso())).toBeInstanceOf(Date)
  })

  it('formats the instant it is given, not "now"', () => {
    expect(dublinTodayIso(new Date('2026-06-15T10:00:00Z'))).toBe('2026-06-15')
    expect(dublinTodayIso(new Date('2026-11-02T10:00:00Z'))).toBe('2026-11-02')
  })

  it('defaults to now', () => {
    expect(dublinTodayIso()).toBe(dublinTodayIso(new Date()))
  })
})
