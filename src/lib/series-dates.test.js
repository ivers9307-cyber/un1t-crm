// HOSTSERIES.1 — the date helpers behind "Make this a series": weekly and
// monthly runs from a start date, on the calendar (no zone maths).
import { describe, it, expect } from 'vitest'
import { weeklyDates, monthlyDates } from './series-dates.js'

describe('weeklyDates', () => {
  it('gives n dates seven days apart AFTER the start', () => {
    expect(weeklyDates('2026-11-14', 4)).toEqual(['2026-11-21', '2026-11-28', '2026-12-05', '2026-12-12'])
  })
  it('a fortnight is a step of 14', () => {
    expect(weeklyDates('2026-11-14', 2, 14)).toEqual(['2026-11-28', '2026-12-12'])
  })
  it('an unparseable start gives nothing', () => {
    expect(weeklyDates('', 4)).toEqual([])
  })
})

describe('monthlyDates', () => {
  it('keeps the day of the month, clamping to the month\'s last day', () => {
    expect(monthlyDates('2026-11-14', 3)).toEqual(['2026-12-14', '2027-01-14', '2027-02-14'])
    expect(monthlyDates('2026-12-31', 3)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31'])
  })
})
