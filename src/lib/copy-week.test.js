// Tests for the copy-week date helpers (sourceWeekEnd / weekDayOffset /
// redateShiftDate). These pin the BST fix: the old route mixed
// `new Date(src + 'T00:00:00')` (local) with `.toISOString().split('T')[0]`
// (UTC), so under Irish Summer Time (UTC+1) local midnight became 23:00
// UTC the *previous* day — dropping Sunday shifts and landing every copy
// one day early. The helpers now format via roster.formatDate (LOCAL
// Y/M/D), so the calendar day is preserved.
//
// Run under both Europe/Dublin and a US TZ to prove host-TZ
// independence:
//   for tz in Europe/Dublin America/Los_Angeles; do
//     TZ=$tz npx vitest run src/lib/copy-week.test.js
//   done

import { describe, it, expect } from 'vitest'
import {
  sourceWeekEnd,
  weekDayOffset,
  redateShiftDate,
} from '../app/api/schedule/shifts/copy-week/route.js'

describe('sourceWeekEnd', () => {
  it('returns Mon + 6 days = Sunday (week stays 7 days)', () => {
    // Week of Mon 29 Jun 2026 (BST). End must be Sun 5 Jul — NOT Sat 4
    // Jul, which is what the toISOString() slip produced.
    expect(sourceWeekEnd('2026-06-29')).toBe('2026-07-05')
  })

  it('works across a month boundary in BST', () => {
    // Mon 27 Jul 2026 -> Sun 2 Aug 2026.
    expect(sourceWeekEnd('2026-07-27')).toBe('2026-08-02')
  })

  it('works outside BST (winter)', () => {
    // Mon 14 Dec 2026 -> Sun 20 Dec 2026.
    expect(sourceWeekEnd('2026-12-14')).toBe('2026-12-20')
  })

  it('spans the spring DST transition cleanly', () => {
    // Clocks go forward Sun 29 Mar 2026. Week of Mon 23 Mar contains
    // the transition; end must still be Sun 29 Mar (7 calendar days).
    expect(sourceWeekEnd('2026-03-23')).toBe('2026-03-29')
  })
})

describe('weekDayOffset', () => {
  it('is exactly 7 for adjacent weeks in BST', () => {
    expect(weekDayOffset('2026-06-29', '2026-07-06')).toBe(7)
  })

  it('is a whole-week multiple even across the spring DST jump', () => {
    // Source week before the transition, target after. A naive ms diff
    // would be 7*24h - 1h; Math.round on local-midnight Dates keeps 7.
    expect(weekDayOffset('2026-03-23', '2026-03-30')).toBe(7)
  })

  it('handles backwards copies (target before source)', () => {
    expect(weekDayOffset('2026-07-06', '2026-06-29')).toBe(-7)
  })
})

describe('redateShiftDate', () => {
  it('shifts a Sunday shift to the next week without dropping it', () => {
    // Sun 5 Jul 2026 + 7 days -> Sun 12 Jul 2026. The original bug
    // dropped Sunday entirely; here it must round-trip to a Sunday.
    expect(redateShiftDate('2026-07-05', 7)).toBe('2026-07-12')
  })

  it('lands a mid-week BST shift on the exact target day', () => {
    // Wed 1 Jul 2026 + 7 -> Wed 8 Jul 2026, not Tue 7 (one day early).
    expect(redateShiftDate('2026-07-01', 7)).toBe('2026-07-08')
  })

  it('re-dates every weekday of a BST week by +7 with no slippage', () => {
    const srcWeek = [
      '2026-06-29', // Mon
      '2026-06-30', // Tue
      '2026-07-01', // Wed
      '2026-07-02', // Thu
      '2026-07-03', // Fri
      '2026-07-04', // Sat
      '2026-07-05', // Sun
    ]
    const expected = [
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
      '2026-07-09',
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
    ]
    expect(srcWeek.map((d) => redateShiftDate(d, 7))).toEqual(expected)
  })

  it('shifts across the spring DST transition correctly', () => {
    // Sat 28 Mar 2026 (pre-transition) + 7 -> Sat 4 Apr 2026.
    expect(redateShiftDate('2026-03-28', 7)).toBe('2026-04-04')
  })
})
