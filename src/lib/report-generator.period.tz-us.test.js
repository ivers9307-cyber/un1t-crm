// ROSTER-FIX.5c2 — the report period, pinned to a US timezone.
//
// The US half of the CLAUDE.md rule ("test date code under TZ=Europe/Dublin
// *and* a US TZ"). Two distinct jobs:
//
//   • Monthly: prove the Dublin fix did not OVERCORRECT. Every US zone is west
//     of UTC, so local midnight is a positive UTC offset within the same
//     calendar day — the old toISOString() formatting happens to agree with
//     formatDate() for the monthly boundaries here. These assertions therefore
//     pin behaviour rather than catch the original bug: they fail if anyone
//     "fixes" the BST slip with a hardcoded offset, or by switching to
//     getUTC*() components, both of which break Los Angeles.
//   • Daily/weekly: these DO catch the local/UTC mix here. period_end is
//     derived from an instant, so after 17:00 PDT the run's UTC date is
//     already tomorrow and toISOString() reports a day the operator has not
//     finished living through.
//
// Vitest gives each test file its own worker, so process.env.TZ here pins only
// this file; the import is dynamic and awaited after the assignment because
// static ESM imports are hoisted above the module body.
process.env.TZ = 'America/Los_Angeles'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { calculatePeriodForSchedule } = await import('./report-generator.js')

describe('calculatePeriodForSchedule — America/Los_Angeles (PDT, UTC-7)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('the host really is on Pacific time', () => {
    expect(new Date('2026-05-15T12:00:00+01:00').getHours()).toBe(4)
  })

  it('monthly → the same previous full calendar month as Dublin sees', () => {
    // Identical instant to the Dublin file's headline case: the period an
    // operator gets must not depend on the host that renders it.
    vi.setSystemTime(new Date('2026-05-15T12:00:00+01:00'))
    expect(calculatePeriodForSchedule('monthly')).toEqual({
      period_start: '2026-04-01', period_end: '2026-04-30',
    })
  })

  it('monthly → follows the LOCAL month when UTC has already rolled over', () => {
    // 31 May 20:00 PDT = 1 June 03:00Z. Local month is May, so the previous
    // full month is April; anything reading getUTCMonth() would say May.
    vi.setSystemTime(new Date('2026-05-31T20:00:00-07:00'))
    expect(calculatePeriodForSchedule('monthly')).toEqual({
      period_start: '2026-04-01', period_end: '2026-04-30',
    })
  })

  it('daily → yesterday LOCAL, not the UTC date the evening already reached', () => {
    // 10 July 20:00 PDT = 11 July 03:00Z. Yesterday is 9 July for the
    // operator; toISOString() said 10 July — a day that has not ended.
    vi.setSystemTime(new Date('2026-07-10T20:00:00-07:00'))
    expect(calculatePeriodForSchedule('daily')).toEqual({
      period_start: '2026-07-09', period_end: '2026-07-09',
    })
  })

  it('weekly → the 7 local days ending yesterday, from a late-evening run', () => {
    vi.setSystemTime(new Date('2026-07-10T20:00:00-07:00'))
    expect(calculatePeriodForSchedule('weekly')).toEqual({
      period_start: '2026-07-03', period_end: '2026-07-09',
    })
  })
})
