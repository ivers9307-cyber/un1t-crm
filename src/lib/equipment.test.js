// EQUIP-MAINT.1 — unit tests for the pure equipment library.
//
// Date maths is the risky part: these must pass identically under
// TZ=Europe/Dublin and a US timezone, and across the BST/GMT boundary.

import { describe, it, expect } from 'vitest'
import {
  dowOf,
  addDays,
  nextOccurrenceOfDow,
  firstDueOn,
  rollForward,
} from './equipment.js'

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
    expect(next >= '2026-08-07').toBe(true)
  })

  it('always lands on the same weekday as the cycle date', () => {
    const next = rollForward({ dueOn: '2026-08-04', intervalWeeks: 13, today: '2026-08-05' })
    expect(dowOf(next)).toBe(dowOf('2026-08-04'))
  })
})

import { validateItems, MAX_ITEMS_PER_TYPE, ITEM_LABEL_MAX } from './equipment.js'

describe('validateItems', () => {
  const ok = [
    { id: 'a1', label: 'Check belt wear', order: 0 },
    { id: 'b2', label: 'Emergency stop works', order: 1 },
  ]

  it('accepts a well-formed list and renumbers order from the array index', () => {
    const res = validateItems([
      { id: 'a1', label: 'Check belt wear', order: 9 },
      { id: 'b2', label: 'Emergency stop works', order: 4 },
    ])
    expect(res.ok).toBe(true)
    expect(res.items).toEqual(ok)
  })

  it('trims labels and ids', () => {
    const res = validateItems([{ id: '  a1  ', label: '  Check belt  ' }])
    expect(res.ok).toBe(true)
    expect(res.items[0]).toEqual({ id: 'a1', label: 'Check belt', order: 0 })
  })

  it('rejects a non-array', () => {
    expect(validateItems('nope').ok).toBe(false)
    expect(validateItems(null).ok).toBe(false)
  })

  it('rejects an empty list', () => {
    const res = validateItems([])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/at least one/i)
  })

  it('rejects more than MAX_ITEMS_PER_TYPE items', () => {
    const many = Array.from({ length: MAX_ITEMS_PER_TYPE + 1 }, (_, i) => ({
      id: `i${i}`, label: `item ${i}`,
    }))
    expect(validateItems(many).ok).toBe(false)
  })

  it('rejects a missing id', () => {
    const res = validateItems([{ label: 'no id' }])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/id/i)
  })

  it('rejects duplicate ids', () => {
    const res = validateItems([
      { id: 'same', label: 'one' },
      { id: 'same', label: 'two' },
    ])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/duplicate/i)
  })

  it('rejects a blank label', () => {
    expect(validateItems([{ id: 'a', label: '   ' }]).ok).toBe(false)
  })

  it('rejects an over-long label', () => {
    const res = validateItems([{ id: 'a', label: 'x'.repeat(ITEM_LABEL_MAX + 1) }])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(new RegExp(String(ITEM_LABEL_MAX)))
  })
})
