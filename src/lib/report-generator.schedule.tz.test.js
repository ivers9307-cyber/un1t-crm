// TZ.11a — scheduled report periods and next runs, Europe/Dublin.
//
// TZ.11a proved Europe/Dublin byte-identical to a frozen copy of the pre-change
// host-clock code (every hour of 2026, every cron slot hour); that sweep was
// retired in TZ.18b. Dublin is now pinned by fixed values around both 2026 EU
// DST changes; zoned-time ≡ dublin-time stays proven by
// shared/zoned-time.parity.test.js.
//   • calculateNextRun for a Europe/Dublin schedule keeps 07:00 UTC (TZ.6's
//     LEGACY_UTC_ANCHORED rule) in summer and winter alike.
//   • calculatePeriodForSchedule for Europe/Dublin is Dublin's yesterday /
//     last month.
// The file runs under TZ=UTC, the host clock on Vercel, so the no-zone
// (backward-compatible) signature reads UTC as production did.
process.env.TZ = 'UTC'
import { describe, it, expect } from 'vitest'

const { calculatePeriodForSchedule, calculateNextRun } = await import('./report-generator.js')

const DUB = 'Europe/Dublin'
const at = (iso) => Date.parse(iso)
const period = (period_start, period_end) => ({ period_start, period_end })

describe('TZ.11a calculateNextRun — Europe/Dublin pinned values (07:00 UTC kept)', () => {
  it.each([
    // [frequency, day_of_week, day_of_month, now, next run]
    ['daily', null, null, '2026-01-15T07:00:00Z', '2026-01-16T07:00:00.000Z'], // winter
    ['daily', null, null, '2026-03-28T23:30:00Z', '2026-03-29T07:00:00.000Z'], // night before spring-forward
    ['daily', null, null, '2026-03-29T01:00:00Z', '2026-03-30T07:00:00.000Z'], // the spring-forward instant
    ['daily', null, null, '2026-10-24T23:30:00Z', '2026-10-25T07:00:00.000Z'], // night before fall-back
    ['daily', null, null, '2026-10-25T01:00:00Z', '2026-10-26T07:00:00.000Z'], // the fall-back instant
    ['weekly', 3, null, '2026-03-29T01:00:00Z', '2026-04-01T07:00:00.000Z'],
    ['weekly', 3, null, '2026-10-24T23:30:00Z', '2026-10-28T07:00:00.000Z'],
    ['monthly', null, 31, '2026-01-15T07:00:00Z', '2026-02-28T07:00:00.000Z'], // clamps to month end
    ['monthly', null, 31, '2026-12-31T23:30:00Z', '2027-01-31T07:00:00.000Z'],
    ['once', null, null, '2026-07-01T07:00:00Z', null],
  ])('%s dow=%s dom=%s at %s', (f, dow, dom, now, expected) => {
    expect(calculateNextRun(f, dow, dom, DUB, at(now))).toBe(expected)
  })
  it('summer: a daily run stays at 07:00Z, not 07:00 IST (06:00Z)', () => {
    expect(calculateNextRun('daily', null, null, DUB, at('2026-07-01T07:00:00Z'))).toBe('2026-07-02T07:00:00.000Z')
  })
})

describe('TZ.11a calculatePeriodForSchedule — Europe/Dublin pinned values', () => {
  it.each([
    // the cron's 07:00-09:59 UTC slots
    ['daily', '2026-01-01T07:00:00Z', period('2025-12-31', '2025-12-31')],
    ['monthly', '2026-01-01T07:00:00Z', period('2025-12-01', '2025-12-31')],
    ['daily', '2026-03-29T07:00:00Z', period('2026-03-28', '2026-03-28')], // spring-forward day
    ['weekly', '2026-03-30T07:00:00Z', period('2026-03-23', '2026-03-29')],
    ['fortnightly', '2026-03-30T07:00:00Z', period('2026-03-16', '2026-03-29')],
    ['monthly', '2026-07-01T07:00:00Z', period('2026-06-01', '2026-06-30')], // summer
    ['daily', '2026-10-25T07:00:00Z', period('2026-10-24', '2026-10-24')], // fall-back day
    ['weekly', '2026-10-26T09:59:00Z', period('2026-10-19', '2026-10-25')],
    ['quarterly', '2026-10-26T09:59:00Z', period('2026-10-19', '2026-10-25')],
  ])('%s at %s', (f, now, expected) => {
    expect(calculatePeriodForSchedule(f, DUB, at(now))).toStrictEqual(expected)
  })
  it("23:30 UTC in summer is already tomorrow in Dublin: the period is Dublin's (the legacy UTC host clock said May)", () => {
    const ms = at('2026-06-30T23:30:00Z') // 00:30 IST on 1 July
    expect(calculatePeriodForSchedule('monthly', DUB, ms)).toEqual({ period_start: '2026-06-01', period_end: '2026-06-30' })
  })
})

describe('TZ.11a no zone passed: the host clock (backward-compatible signature, UTC here)', () => {
  it('reads the UTC date, not Dublin', () => {
    const ms = at('2026-06-30T23:30:00Z') // still 30 June in UTC
    expect(calculatePeriodForSchedule('daily', undefined, ms)).toStrictEqual(period('2026-06-29', '2026-06-29'))
    expect(calculatePeriodForSchedule('monthly', undefined, ms)).toStrictEqual(period('2026-05-01', '2026-05-31'))
    expect(calculateNextRun('weekly', 2, null, undefined, ms)).toBe('2026-07-07T07:00:00.000Z')
  })
  it('around the EU spring-forward', () => {
    const ms = at('2026-03-29T00:59:00Z')
    expect(calculatePeriodForSchedule('daily', undefined, ms)).toStrictEqual(period('2026-03-28', '2026-03-28'))
    expect(calculatePeriodForSchedule('monthly', undefined, ms)).toStrictEqual(period('2026-02-01', '2026-02-28'))
    expect(calculateNextRun('weekly', 2, null, undefined, ms)).toBe('2026-03-31T07:00:00.000Z')
  })
})
