// EQUIP-MAINT.1 — unit tests for the pure date-arithmetic module.
//
// Split out of equipment.test.js (PR1 code review): date maths is the
// only genuinely risky and reusable part of this feature. These must
// pass identically under TZ=Europe/Dublin and a US timezone, and
// across the BST/GMT boundary.

import { describe, it, expect } from 'vitest'
import {
  dowOf,
  addDays,
  nextOccurrenceOfDow,
  firstDueOn,
  rollForward,
} from './equipment-dates.js'

describe('dowOf', () => {
  it('matches the Postgres dow convention (0 = Sunday)', () => {
    expect(dowOf('2026-08-02')).toBe(0) // Sunday
    expect(dowOf('2026-08-03')).toBe(1) // Monday
    expect(dowOf('2026-08-04')).toBe(2) // Tuesday
    expect(dowOf('2026-08-08')).toBe(6) // Saturday
  })
})

describe('addDays', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2026-08-30', 3)).toBe('2026-09-02')
  })

  it('adds days across a year boundary', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
  })

  it('crosses the BST→GMT boundary without shifting the date', () => {
    // Clocks go back 2026-10-25 in Dublin. A naive local-time
    // implementation lands on 2026-10-25 here instead of 10-26.
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26')
  })

  it('crosses the GMT→BST boundary without shifting the date', () => {
    // Clocks go forward 2026-03-29.
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30')
  })

  it('subtracts days when given a negative count', () => {
    expect(addDays('2026-08-04', -5)).toBe('2026-07-30')
  })

  it('throws on a malformed date string rather than silently returning garbage', () => {
    expect(() => addDays('2026-8-4', 1)).toThrow(RangeError)
    expect(() => addDays('04-08-2026', 1)).toThrow(RangeError)
    expect(() => addDays('not-a-date', 1)).toThrow(RangeError)
  })
})

describe('nextOccurrenceOfDow', () => {
  it('returns the same date when it already falls on that weekday', () => {
    expect(nextOccurrenceOfDow('2026-08-04', 2)).toBe('2026-08-04') // Tue
  })

  it('advances to the next occurrence otherwise', () => {
    expect(nextOccurrenceOfDow('2026-08-05', 2)).toBe('2026-08-11') // Wed -> Tue
  })
})

describe('firstDueOn', () => {
  it('uses the operator-supplied date when given', () => {
    expect(
      firstDueOn({ today: '2026-08-03', inspectionDayOfWeek: 2, explicitFirstDue: '2026-09-01' })
    ).toBe('2026-09-01')
  })

  it('uses the next inspection weekday on or after today', () => {
    expect(firstDueOn({ today: '2026-08-03', inspectionDayOfWeek: 2 })).toBe('2026-08-04')
  })

  it('falls back to today when the location has no settings row', () => {
    expect(firstDueOn({ today: '2026-08-03', inspectionDayOfWeek: null })).toBe('2026-08-03')
  })

  it('handles Sunday (0), which is falsy and must not be mistaken for "no settings row"', () => {
    // firstDueOn deliberately checks `=== null || === undefined`, not
    // truthiness, so a Sunday-inspection location works. A refactor to
    // `if (!inspectionDayOfWeek)` would break every such location while
    // leaving every other test in this file green.
    expect(firstDueOn({ today: '2026-08-03', inspectionDayOfWeek: 0 })).toBe('2026-08-09') // Mon -> Sun
  })

  it('throws for a non-integer or out-of-range inspectionDayOfWeek', () => {
    for (const bad of ['2', false, 2.5, 7, -1]) {
      expect(() => firstDueOn({ today: '2026-08-03', inspectionDayOfWeek: bad })).toThrow(RangeError)
    }
  })
})

describe('rollForward', () => {
  it('measures from the cycle date, not the submission date', () => {
    // Due Tue 04 Aug, four-weekly, actually inspected late on 07 Aug.
    // Must land 01 Sep (04 Aug + 28d), NOT 04 Sep.
    expect(rollForward({ dueOn: '2026-08-04', intervalWeeks: 4, today: '2026-08-07' }))
      .toBe('2026-09-01')
  })

  it('advances in whole intervals when more than one cycle overdue', () => {
    // Due 04 Aug, weekly, not inspected until 26 Aug. One step lands
    // 11 Aug which is still past, so it must keep stepping to 01 Sep.
    expect(rollForward({ dueOn: '2026-08-04', intervalWeeks: 1, today: '2026-08-26' }))
      .toBe('2026-09-01')
  })

  it('never returns a date before today', () => {
    const next = rollForward({ dueOn: '2026-01-06', intervalWeeks: 13, today: '2026-08-07' })
    expect(next).toBe('2026-10-06') // exact value — `>= today` alone would pass for any future date
  })

  it('always lands on the same weekday as the cycle date', () => {
    const next = rollForward({ dueOn: '2026-08-04', intervalWeeks: 13, today: '2026-08-05' })
    expect(next).toBe('2026-11-03')
    // Checked against native Date, not the library's own dowOf, so this
    // doesn't just test the implementation against itself.
    expect(new Date(next + 'T00:00:00Z').getUTCDay()).toBe(2) // Tuesday, same as 2026-08-04
  })

  it('handles an on-time or early inspection the same as a late one', () => {
    // Every case above is a LATE inspection (today > dueOn). The most
    // common real path — submitting on or before the due date — was
    // untested.
    expect(rollForward({ dueOn: '2026-08-04', intervalWeeks: 4, today: '2026-08-01' }))
      .toBe('2026-09-01')
  })

  it('accepts next === today exactly, not just next > today', () => {
    const today = addDays('2026-08-04', 28) // exactly one cycle ahead
    expect(rollForward({ dueOn: '2026-08-04', intervalWeeks: 4, today })).toBe(today)
  })

  it('throws RangeError rather than hanging or silently no-op-ing on an invalid intervalWeeks', () => {
    // 0/negative with a past dueOn would spin forever without the guard.
    for (const bad of [0, -1, null, NaN, 1.5, 53, 'four']) {
      expect(() => rollForward({ dueOn: '2026-08-04', intervalWeeks: bad, today: '2026-08-01' }))
        .toThrow(RangeError)
    }
  })

  it('throws even when dueOn is in the future — the quiet failure mode', () => {
    // Without the guard: dueOn in the future + intervalWeeks 0 means the
    // while-loop never runs and rollForward returns dueOn unchanged, no
    // error. The submit route would report success and stamp
    // last_inspected_on while the asset's schedule silently stops
    // advancing — worse than a 500 on a compliance feature.
    expect(() => rollForward({ dueOn: '2026-09-01', intervalWeeks: 0, today: '2026-08-04' }))
      .toThrow(RangeError)
  })
})
