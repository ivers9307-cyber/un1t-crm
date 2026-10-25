// ROSTER-FIX.5 — the weekday convention that made every weekly scheduled
// report fire a day early.
//
// scheduled_reports.day_of_week is consumed by calculateNextRun() as
// `(day_of_week - date.getDay() + 7) % 7`, i.e. JS's convention (0=Sun). The
// UI presented a Monday-first list and wrote its INDEX, so "Monday" stored 0
// and ran on Sunday, "Sunday" stored 6 and ran on Saturday. These two
// functions are the only place that conversion is allowed to happen.

import { describe, it, expect } from 'vitest'
import { toJsDay, fromJsDay, DAY_NAMES_MONDAY_FIRST } from './report-schedule-days'

describe('DAY_NAMES_MONDAY_FIRST', () => {
  it('is the display order, Monday first', () => {
    expect(DAY_NAMES_MONDAY_FIRST).toEqual([
      'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    ])
  })
})

describe('toJsDay', () => {
  it('maps the Monday-first display index onto Date.getDay()', () => {
    // Monday-first index → JS weekday.
    expect([0, 1, 2, 3, 4, 5, 6].map(toJsDay)).toEqual([1, 2, 3, 4, 5, 6, 0])
  })

  it('agrees with a real Date for every day of one week', () => {
    // 2026-05-04 is a Monday.
    for (let i = 0; i < 7; i++) {
      const d = new Date(2026, 4, 4 + i)
      expect(toJsDay(i)).toBe(d.getDay())
    }
  })
})

describe('fromJsDay', () => {
  it('maps Date.getDay() back onto the display index', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(fromJsDay)).toEqual([6, 0, 1, 2, 3, 4, 5])
  })

  it('names the stored value correctly — Sunday is 0, not index 0', () => {
    expect(DAY_NAMES_MONDAY_FIRST[fromJsDay(0)]).toBe('Sunday')
    expect(DAY_NAMES_MONDAY_FIRST[fromJsDay(1)]).toBe('Monday')
    expect(DAY_NAMES_MONDAY_FIRST[fromJsDay(6)]).toBe('Saturday')
  })
})

describe('round trip', () => {
  it('fromJsDay(toJsDay(i)) === i for every display index', () => {
    for (let i = 0; i < 7; i++) expect(fromJsDay(toJsDay(i))).toBe(i)
  })
  it('toJsDay(fromJsDay(d)) === d for every JS weekday', () => {
    for (let d = 0; d < 7; d++) expect(toJsDay(fromJsDay(d))).toBe(d)
  })
})
