// ROSTER-FIX.5c2 — the monthly report period, pinned to Europe/Dublin.
//
// WHY a whole file just for this: report-generator.test.js exercises
// calculatePeriodForSchedule but pins no timezone, and CI runners are UTC.
// Under UTC the old `toISOString()` formatting of a LOCAL-midnight Date is
// indistinguishable from the correct `formatDate()`, so the bug this PR fixes
// — every monthly report covering 31 Mar – 29 Apr instead of 1 – 30 Apr for
// Dublin operators — would go green in CI forever. CLAUDE.md requires date
// code to be tested under TZ=Europe/Dublin *and* a US timezone; this file is
// the Dublin half, report-generator.period.tz-us.test.js the US half.
//
// Vitest runs each test file in its own worker, so setting process.env.TZ here
// pins only this file. Node (>=16) rebuilds its tz cache on assignment. The
// import is dynamic and awaited AFTER the assignment because static ESM
// imports are hoisted above the module body — a static import would evaluate
// report-generator (and everything it pulls in) while TZ was still the host's.
process.env.TZ = 'Europe/Dublin'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { calculatePeriodForSchedule } = await import('./report-generator.js')

describe('calculatePeriodForSchedule — Europe/Dublin (BST, UTC+1)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('the host really is on Dublin time', () => {
    // Guard the guard: if TZ ever stops taking effect the assertions below
    // would silently degrade into a UTC re-run of the existing suite.
    expect(new Date('2026-05-15T12:00:00+01:00').getHours()).toBe(12)
  })

  it('monthly → the previous FULL calendar month, not a day short', () => {
    // Mid-May, inside Irish Summer Time. new Date(2026, 3, 1) is local
    // midnight = 2026-03-31T23:00Z, so toISOString() yielded 2026-03-31.
    vi.setSystemTime(new Date('2026-05-15T12:00:00+01:00'))
    expect(calculatePeriodForSchedule('monthly')).toEqual({
      period_start: '2026-04-01', period_end: '2026-04-30',
    })
  })

  it('monthly → holds when the run itself lands on local midnight in BST', () => {
    // 1 June 00:30 IST = 31 May 23:30Z: the run's own UTC date is in the
    // PREVIOUS month, so anything reading UTC components reports April.
    vi.setSystemTime(new Date('2026-06-01T00:30:00+01:00'))
    expect(calculatePeriodForSchedule('monthly')).toEqual({
      period_start: '2026-05-01', period_end: '2026-05-31',
    })
  })

  it('monthly → holds across the GMT/BST boundary (April period, March run)', () => {
    // 15 April is BST; the period it reports (March) is GMT. Formatting must
    // not borrow the run date's offset.
    vi.setSystemTime(new Date('2026-04-15T12:00:00+01:00'))
    expect(calculatePeriodForSchedule('monthly')).toEqual({
      period_start: '2026-03-01', period_end: '2026-03-31',
    })
  })

  it('daily → the operator’s yesterday even late in the local evening', () => {
    // 23:30 IST = 22:30Z the same day here, but the local-vs-UTC split is the
    // same defect class; keep the daily branch pinned alongside monthly.
    vi.setSystemTime(new Date('2026-07-10T23:30:00+01:00'))
    expect(calculatePeriodForSchedule('daily')).toEqual({
      period_start: '2026-07-09', period_end: '2026-07-09',
    })
  })
})
