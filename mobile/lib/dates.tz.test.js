// ROSTER-FIX.7 — dublinTodayIso() under a NEGATIVE-offset device timezone.
//
// TZ is pinned per FILE: process.env.TZ is set before the module under test is
// loaded (hence the dynamic import — a static one is hoisted above this line),
// and each test file gets its own module registry, so dates.js is evaluated
// fresh under this pin rather than reused from dates.tz-dublin.test.js.
//
// ROSTER-FIX.7h — process.env is per PROCESS, though, and vitest reuses a
// worker across files. The previous value is captured before the pin and put
// back in afterAll so the pin cannot outlive this file.

const PREV_TZ = process.env.TZ
process.env.TZ = 'America/New_York'

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

describe('dublinTodayIso under TZ=America/New_York', () => {
  it('confirms the harness really pinned the device timezone', () => {
    // If this fails, every assertion below is testing nothing.
    expect(new Date('2026-01-01T00:30:00Z').getTimezoneOffset()).toBe(300)
  })

  it('is the STUDIO day, not the phone day, just after Dublin midnight', () => {
    vi.setSystemTime(new Date('2026-01-01T00:30:00Z'))
    expect(dublinTodayIso()).toBe('2026-01-01')
    // The bug this closes: the device says it is still last year.
    expect(isoDate(new Date())).toBe('2025-12-31')
  })

  it('follows Irish summer time (IST, UTC+1), not the device offset', () => {
    vi.setSystemTime(new Date('2026-07-01T23:30:00Z'))
    expect(dublinTodayIso()).toBe('2026-07-02')
    expect(isoDate(new Date())).toBe('2026-07-01')
  })

  it('agrees with the device during the shared part of the day', () => {
    vi.setSystemTime(new Date('2026-03-16T12:00:00Z'))
    expect(dublinTodayIso()).toBe('2026-03-16')
    expect(isoDate(new Date())).toBe('2026-03-16')
  })

  it('accepts an explicit instant so callers can be tested without fake timers', () => {
    expect(dublinTodayIso(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31')
    expect(dublinTodayIso(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01-01')
  })
})
