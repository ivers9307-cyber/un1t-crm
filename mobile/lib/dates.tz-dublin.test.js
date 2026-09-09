// ROSTER-FIX.7 — the same dublinTodayIso() cases with the device already ON
// Dublin time (every phone in the estate, normally). The point of the pair is
// that the answer must be IDENTICAL to dates.tz.test.js's: a helper that only
// works when the device happens to agree is not a fix.
//
// TZ is pinned per FILE — see the header of dates.tz.test.js for why the
// import is dynamic and why the previous value is restored afterwards.

const PREV_TZ = process.env.TZ
process.env.TZ = 'Europe/Dublin'

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

const { dublinTodayIso, isoDate } = await import('./dates')

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

afterAll(() => {
  // ROSTER-FIX.7h — put the worker's TZ back. vitest gives each test FILE its
  // own module registry, but a worker process is reused across files, so the
  // pin above outlives this file and hands whatever runs next in the same
  // worker a timezone it never asked for. Restored to what was there, and
  // deleted outright if the variable was unset (setting it to 'undefined'
  // would be a pin to a garbage zone, not an absence).
  if (PREV_TZ === undefined) delete process.env.TZ
  else process.env.TZ = PREV_TZ
})

describe('dublinTodayIso under TZ=Europe/Dublin', () => {
  it('confirms the harness really pinned the device timezone', () => {
    expect(new Date('2026-01-01T00:30:00Z').getTimezoneOffset()).toBe(0)
    expect(new Date('2026-07-01T23:30:00Z').getTimezoneOffset()).toBe(-60)
  })

  it('gives the same answers as the New York run, and matches the device', () => {
    vi.setSystemTime(new Date('2026-01-01T00:30:00Z'))
    expect(dublinTodayIso()).toBe('2026-01-01')
    expect(isoDate(new Date())).toBe('2026-01-01')

    vi.setSystemTime(new Date('2026-07-01T23:30:00Z'))
    expect(dublinTodayIso()).toBe('2026-07-02')
    expect(isoDate(new Date())).toBe('2026-07-02')

    vi.setSystemTime(new Date('2026-03-16T12:00:00Z'))
    expect(dublinTodayIso()).toBe('2026-03-16')
    expect(isoDate(new Date())).toBe('2026-03-16')
  })

  it('handles the IST changeover days without slipping a day', () => {
    // Clocks go forward 01:00 -> 02:00 on 2026-03-29, back on 2026-10-25.
    expect(dublinTodayIso(new Date('2026-03-29T00:30:00Z'))).toBe('2026-03-29')
    expect(dublinTodayIso(new Date('2026-03-29T01:30:00Z'))).toBe('2026-03-29')
    expect(dublinTodayIso(new Date('2026-10-24T23:30:00Z'))).toBe('2026-10-25')
    expect(dublinTodayIso(new Date('2026-10-25T23:30:00Z'))).toBe('2026-10-25')
  })

  it('accepts an explicit instant', () => {
    expect(dublinTodayIso(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31')
  })
})
