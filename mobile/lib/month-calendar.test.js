// mobile/lib/month-calendar.test.js
//
// AVAIL.2 review — components/MonthCalendar.jsx's tap rule, pulled out so the
// forms that use the calendar (leave, availability) can be tested against
// the REAL rule rather than a copy of it. Pure strings: any TZ.

import { describe, it, expect } from 'vitest'
import { calendarTap } from './month-calendar'

describe('calendarTap', () => {
  it('no start yet: the tap is a one-day selection', () => {
    expect(calendarTap({ startDate: null, endDate: null }, '2026-10-03')).toEqual({ start: '2026-10-03', end: null })
  })
  it('a start and no end: a later tap extends, an earlier one restarts', () => {
    expect(calendarTap({ startDate: '2026-10-03', endDate: null }, '2026-10-05')).toEqual({ start: '2026-10-03', end: '2026-10-05' })
    expect(calendarTap({ startDate: '2026-10-03', endDate: null }, '2026-10-03')).toEqual({ start: '2026-10-03', end: '2026-10-03' })
    expect(calendarTap({ startDate: '2026-10-03', endDate: null }, '2026-10-01')).toEqual({ start: '2026-10-01', end: null })
  })
  it('both ends held: the tap starts afresh', () => {
    expect(calendarTap({ startDate: '2026-10-03', endDate: '2026-10-05' }, '2026-10-09')).toEqual({ start: '2026-10-09', end: null })
  })
  it('a day before minDate is ignored', () => {
    expect(calendarTap({ startDate: null, endDate: null, minDate: '2026-09-25' }, '2026-09-24')).toBeNull()
  })
})
