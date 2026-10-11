// TZ.11a — scheduled report periods and next runs, Europe/Dublin byte-identity.
//
// The legacy helpers read the HOST clock, which is UTC on Vercel, so the frozen
// copies run here under TZ=UTC: that is exactly what production computed.
//   • calculateNextRun for a Europe/Dublin schedule keeps 07:00 UTC (TZ.6's
//     LEGACY_UTC_ANCHORED rule): identical at EVERY instant of 2026.
//   • calculatePeriodForSchedule for Europe/Dublin is Dublin's yesterday /
//     last month. The cron computes it only at its 07:00 UTC slot (TZ.6 lets a
//     Dublin slot catch up to 09:59 UTC), when Dublin's date IS the UTC date:
//     identical at every one of those hours of 2026. The one difference (an
//     invocation 23:00-24:00 UTC in Irish summer time, which no schedule makes)
//     is pinned below so it is a decision, not an accident.
process.env.TZ = 'UTC'
import { describe, it, expect } from 'vitest'

const { calculatePeriodForSchedule, calculateNextRun } = await import('./report-generator.js')
const L = await import('./tz-11a.legacy-dublin.test-helpers.js')

const DUB = 'Europe/Dublin'
const SAMPLES = [
  '2026-03-07T04:30:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z',
  '2026-03-28T23:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z',
  '2026-10-24T23:30:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z',
  '2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z',
  '2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-12-31T23:30:00Z',
]
const FREQS = ['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly']

// Every day of 2026 at the hours the cron computes a period (07:00-09:59 UTC).
const SLOT_INSTANTS = []
for (let d = Date.UTC(2026, 0, 1); d < Date.UTC(2027, 0, 1); d += 86_400_000) {
  for (const h of [7, 8, 9]) SLOT_INSTANTS.push(d + h * 3_600_000, d + h * 3_600_000 + 59 * 60_000)
}

describe('TZ.11a calculateNextRun — Europe/Dublin is byte-identical (07:00 UTC kept)', () => {
  const cases = [
    ['daily', null, null], ['weekly', 0, null], ['weekly', 3, null], ['fortnightly', 5, null],
    ['monthly', null, null], ['monthly', null, 31], ['monthly', null, 30], ['once', null, null], ['weekly', null, null],
  ]
  it.each(SAMPLES)('%s', (iso) => {
    const nowMs = Date.parse(iso)
    for (const [f, dow, dom] of cases) {
      expect(calculateNextRun(f, dow, dom, DUB, nowMs)).toBe(L.calculateNextRunLegacy(f, dow, dom, nowMs))
    }
  })
  it('every hour of 2026', () => {
    for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 3_600_000) {
      for (const [f, dow, dom] of cases) {
        expect(calculateNextRun(f, dow, dom, DUB, ms)).toBe(L.calculateNextRunLegacy(f, dow, dom, ms))
      }
    }
  })
  it('summer: a daily run stays at 07:00Z, not 07:00 IST (06:00Z)', () => {
    expect(calculateNextRun('daily', null, null, DUB, Date.parse('2026-07-01T07:00:00Z'))).toBe('2026-07-02T07:00:00.000Z')
  })
})

describe('TZ.11a calculatePeriodForSchedule — Europe/Dublin', () => {
  it('is byte-identical at every cron slot hour of 2026', () => {
    for (const ms of SLOT_INSTANTS) {
      for (const f of FREQS) {
        expect(calculatePeriodForSchedule(f, DUB, ms)).toStrictEqual(L.calculatePeriodForScheduleLegacy(f, ms))
      }
    }
  })
  it("23:30 UTC in summer is already tomorrow in Dublin: the period is Dublin's (the legacy host read UTC)", () => {
    const ms = Date.parse('2026-06-30T23:30:00Z') // 00:30 IST on 1 July
    expect(calculatePeriodForSchedule('monthly', DUB, ms)).toEqual({ period_start: '2026-06-01', period_end: '2026-06-30' })
    expect(L.calculatePeriodForScheduleLegacy('monthly', ms)).toEqual({ period_start: '2026-05-01', period_end: '2026-05-31' })
  })
})

describe('TZ.11a no zone passed: the legacy host clock (backward-compatible signature)', () => {
  it.each(SAMPLES)('%s', (iso) => {
    const nowMs = Date.parse(iso)
    for (const f of FREQS) {
      expect(calculatePeriodForSchedule(f, undefined, nowMs)).toStrictEqual(L.calculatePeriodForScheduleLegacy(f, nowMs))
    }
    expect(calculateNextRun('weekly', 2, null, undefined, nowMs)).toBe(L.calculateNextRunLegacy('weekly', 2, null, nowMs))
  })
})
