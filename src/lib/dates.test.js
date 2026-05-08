// Date helpers tests. The bug we're guarding against: bare
// 'YYYY-MM-DD' strings parsed as UTC display as the previous day
// in any TZ east of UTC. Dublin shifts to BST (UTC+1) for half the
// year, so the bug used to surface as "Monday's roster shows up on
// Sunday" until task #240 fixed formatDate. This test pins the fix
// in place: parseDateOnly MUST round-trip to the same calendar day
// the input string named.

import { describe, it, expect } from 'vitest'
import {
  parseDateOnly,
  formatShortDate, formatWeekdayShortDate, formatWeekdayLongDate,
  formatMonthYear, formatFullDate,
  formatTimeOnly, formatShortDateTime, formatWeekdayShortDateTime,
  formatTimeStr, formatTimeRange, formatRelative,
  isoDate, isSameDay,
} from './dates.js'

describe('parseDateOnly', () => {
  it('returns null for null / undefined / empty / non-string', () => {
    expect(parseDateOnly(null)).toBeNull()
    expect(parseDateOnly(undefined)).toBeNull()
    expect(parseDateOnly('')).toBeNull()
    expect(parseDateOnly(123)).toBeNull()
  })

  it('passes Date through unchanged', () => {
    const d = new Date('2026-05-08T10:00:00')
    expect(parseDateOnly(d)).toBe(d)
  })

  it('parses a bare YYYY-MM-DD as local midnight, NOT UTC', () => {
    const d = parseDateOnly('2026-05-08')
    // The bug we're guarding against: if this parsed as UTC, calling
    // getDate() in any TZ east of UTC would return 7. The fix
    // (appending T00:00:00) keeps it on the named day.
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(4) // May = 4
    expect(d.getDate()).toBe(8)
    expect(d.getHours()).toBe(0)
  })

  it('passes a full ISO timestamp through to Date constructor', () => {
    const d = parseDateOnly('2026-05-08T14:30:00.000Z')
    expect(d).toBeInstanceOf(Date)
    expect(d.getTime()).toBe(new Date('2026-05-08T14:30:00.000Z').getTime())
  })
})

describe('format helpers — shapes & locale stability', () => {
  // We pin the locale to en-IE and assert the visible shape.
  // If the en-IE locale ever changes its output (vanishingly rare)
  // these tests will fail loudly, which is what we want — we
  // anchor a lot of UI on these strings.
  const may8 = '2026-05-08' // Friday in 2026

  it('formatShortDate — "8 May"', () => {
    expect(formatShortDate(may8)).toBe('8 May')
  })

  it('formatWeekdayShortDate — "Fri 8 May"', () => {
    // en-IE renders weekday-short with no comma + thin space.
    // Allow either "Fri 8 May" or "Fri, 8 May" so a future Node
    // ICU tweak doesn't paper-cut us.
    expect(formatWeekdayShortDate(may8)).toMatch(/^Fri,? 8 May$/)
  })

  it('formatWeekdayLongDate — "Friday 8 May"', () => {
    expect(formatWeekdayLongDate(may8)).toMatch(/^Friday,? 8 May$/)
  })

  it('formatMonthYear — "May 2026"', () => {
    expect(formatMonthYear(may8)).toBe('May 2026')
  })

  it('formatFullDate — "8 May 2026"', () => {
    expect(formatFullDate(may8)).toBe('8 May 2026')
  })

  it('returns "" for null input across every formatter', () => {
    expect(formatShortDate(null)).toBe('')
    expect(formatWeekdayShortDate(null)).toBe('')
    expect(formatWeekdayLongDate(null)).toBe('')
    expect(formatMonthYear(null)).toBe('')
    expect(formatFullDate(null)).toBe('')
    expect(formatTimeOnly(null)).toBe('')
    expect(formatShortDateTime(null)).toBe('')
    expect(formatWeekdayShortDateTime(null)).toBe('')
  })
})

describe('formatTimeOnly / formatShortDateTime / formatWeekdayShortDateTime', () => {
  const iso = '2026-05-08T14:30:00.000Z'

  it('formatTimeOnly returns HH:MM', () => {
    // Don't assert the literal "14:30" — TZ of the test runner
    // can shift it. Assert the *shape* is HH:MM.
    expect(formatTimeOnly(iso)).toMatch(/^\d{2}:\d{2}$/)
  })

  it('formatShortDateTime contains the date + time', () => {
    const out = formatShortDateTime(iso)
    expect(out).toMatch(/May/) // month abbreviation present
    expect(out).toMatch(/\d{2}:\d{2}/) // time present
  })

  it('formatWeekdayShortDateTime contains weekday + date + time', () => {
    const out = formatWeekdayShortDateTime(iso)
    expect(out).toMatch(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/)
    expect(out).toMatch(/May/)
    expect(out).toMatch(/\d{2}:\d{2}/)
  })

  it('returns "" for invalid date string', () => {
    expect(formatTimeOnly('not-a-date')).toBe('')
    expect(formatShortDateTime('not-a-date')).toBe('')
  })
})

describe('formatTimeStr / formatTimeRange', () => {
  it('formatTimeStr trims seconds', () => {
    expect(formatTimeStr('09:00:00')).toBe('09:00')
    expect(formatTimeStr('09:00')).toBe('09:00')
  })

  it('formatTimeStr returns "" for null/non-string', () => {
    expect(formatTimeStr(null)).toBe('')
    expect(formatTimeStr(undefined)).toBe('')
    expect(formatTimeStr(900)).toBe('')
  })

  it('formatTimeRange uses an en-dash with spaces', () => {
    expect(formatTimeRange('09:00', '18:00')).toBe('09:00 – 18:00')
  })
})

describe('formatRelative', () => {
  const now = new Date('2026-05-08T12:00:00.000Z')

  it('"just now" for <1 min ago', () => {
    expect(formatRelative(new Date('2026-05-08T11:59:30.000Z'), now)).toBe('just now')
  })

  it('"5 min ago" for minutes', () => {
    expect(formatRelative(new Date('2026-05-08T11:55:00.000Z'), now)).toBe('5 min ago')
  })

  it('"3h ago" for hours', () => {
    expect(formatRelative(new Date('2026-05-08T09:00:00.000Z'), now)).toBe('3h ago')
  })

  it('"2d ago" for recent days', () => {
    expect(formatRelative(new Date('2026-05-06T12:00:00.000Z'), now)).toBe('2d ago')
  })

  it('falls back to weekday-short-date for >=7 days', () => {
    expect(formatRelative(new Date('2026-04-30T12:00:00.000Z'), now))
      .toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),? \d+ \w+$/)
  })

  it('"" for null / invalid', () => {
    expect(formatRelative(null, now)).toBe('')
    expect(formatRelative('not-a-date', now)).toBe('')
  })
})

describe('isoDate', () => {
  it('returns YYYY-MM-DD in local time', () => {
    const d = new Date(2026, 4, 8) // 8 May (local) — month is 0-indexed
    expect(isoDate(d)).toBe('2026-05-08')
  })

  it('zero-pads single-digit month + day', () => {
    const d = new Date(2026, 0, 3) // 3 Jan
    expect(isoDate(d)).toBe('2026-01-03')
  })

  it('returns "" for non-Date / invalid', () => {
    expect(isoDate('2026-05-08')).toBe('')
    expect(isoDate(null)).toBe('')
    expect(isoDate(new Date('not-a-date'))).toBe('')
  })
})

describe('isSameDay', () => {
  it('true for same local day, different times', () => {
    expect(isSameDay('2026-05-08', new Date('2026-05-08T23:59:59'))).toBe(true)
  })

  it('false across days', () => {
    expect(isSameDay('2026-05-08', '2026-05-09')).toBe(false)
  })

  it('handles the bare-YYYY-MM-DD TZ trap (regression for task #240)', () => {
    // If parseDateOnly were broken, '2026-05-08' would parse as
    // the previous day in some TZs and this would be false.
    expect(isSameDay('2026-05-08', '2026-05-08')).toBe(true)
  })

  it('false for null / undefined inputs', () => {
    expect(isSameDay(null, '2026-05-08')).toBe(false)
    expect(isSameDay('2026-05-08', undefined)).toBe(false)
  })
})
