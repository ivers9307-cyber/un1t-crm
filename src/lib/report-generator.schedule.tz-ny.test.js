// TZ.11a — scheduled report periods and next runs follow the schedule's studio
// zone. Host zone is neither of the zones under test, so nothing here can be
// reading the host clock.
process.env.TZ = 'America/Los_Angeles'
import { describe, it, expect } from 'vitest'

const { calculatePeriodForSchedule, calculateNextRun } = await import('./report-generator.js')

const NY = 'America/New_York'
const at = (iso) => Date.parse(iso)

describe('TZ.11a calculatePeriodForSchedule — America/New_York across DST', () => {
  it("daily = New York's yesterday, at the 07:00 local slot on both DST mornings", () => {
    // Sun 8 Mar 2026 07:00 EDT = 11:00Z (spring forward at 02:00 that morning)
    expect(calculatePeriodForSchedule('daily', NY, at('2026-03-08T11:00:00Z')))
      .toEqual({ period_start: '2026-03-07', period_end: '2026-03-07' })
    // Sun 1 Nov 2026 07:00 EST = 12:00Z (fall back at 02:00 that morning)
    expect(calculatePeriodForSchedule('daily', NY, at('2026-11-01T12:00:00Z')))
      .toEqual({ period_start: '2026-10-31', period_end: '2026-10-31' })
  })
  it('the local day flips at New York midnight, not Dublin or UTC midnight', () => {
    // 1 Nov 03:30Z = 23:30 EDT on 31 Oct: still October in New York
    expect(calculatePeriodForSchedule('monthly', NY, at('2026-11-01T03:30:00Z')))
      .toEqual({ period_start: '2026-09-01', period_end: '2026-09-30' })
    expect(calculatePeriodForSchedule('monthly', NY, at('2026-11-01T04:30:00Z')))
      .toEqual({ period_start: '2026-10-01', period_end: '2026-10-31' })
  })
  it('weekly and fortnightly end on the local yesterday', () => {
    expect(calculatePeriodForSchedule('weekly', NY, at('2026-11-01T12:00:00Z')))
      .toEqual({ period_start: '2026-10-25', period_end: '2026-10-31' })
    expect(calculatePeriodForSchedule('fortnightly', NY, at('2026-03-08T11:00:00Z')))
      .toEqual({ period_start: '2026-02-22', period_end: '2026-03-07' })
  })
})

describe('TZ.11a calculateNextRun — 07:00 New York wall clock, both seasons', () => {
  it('daily across the fall-back: 07:00 EDT (11:00Z) then 07:00 EST (12:00Z)', () => {
    expect(calculateNextRun('daily', null, null, NY, at('2026-10-30T11:00:00Z'))).toBe('2026-10-31T11:00:00.000Z')
    expect(calculateNextRun('daily', null, null, NY, at('2026-10-31T11:00:00Z'))).toBe('2026-11-01T12:00:00.000Z')
  })
  it('daily across the spring-forward: 07:00 EST (12:00Z) then 07:00 EDT (11:00Z)', () => {
    expect(calculateNextRun('daily', null, null, NY, at('2026-03-07T12:00:00Z'))).toBe('2026-03-08T11:00:00.000Z')
  })
  it('weekly reads the LOCAL weekday', () => {
    // Sat 31 Oct 23:30 EDT = Sun 1 Nov 03:30Z. Local weekday is Saturday (6):
    // a Sunday (0) schedule is tomorrow, not a week out.
    expect(calculateNextRun('weekly', 0, null, NY, at('2026-11-01T03:30:00Z'))).toBe('2026-11-01T12:00:00.000Z')
    // On the target weekday itself: a whole week out.
    expect(calculateNextRun('weekly', 6, null, NY, at('2026-11-01T03:30:00Z'))).toBe('2026-11-07T12:00:00.000Z')
    expect(calculateNextRun('fortnightly', 0, null, NY, at('2026-11-01T03:30:00Z'))).toBe('2026-11-08T12:00:00.000Z')
  })
  it('monthly: the given day of next local month at 07:00, clamped', () => {
    expect(calculateNextRun('monthly', null, null, NY, at('2026-10-15T15:00:00Z'))).toBe('2026-11-01T12:00:00.000Z')
    expect(calculateNextRun('monthly', null, 31, NY, at('2026-10-15T15:00:00Z'))).toBe('2026-11-30T12:00:00.000Z')
    expect(calculateNextRun('monthly', null, 1, NY, at('2026-02-10T15:00:00Z'))).toBe('2026-03-01T12:00:00.000Z')
  })
  it('once / weekly without a weekday → null', () => {
    expect(calculateNextRun('once', null, null, NY, at('2026-10-15T15:00:00Z'))).toBeNull()
    expect(calculateNextRun('weekly', null, null, NY, at('2026-10-15T15:00:00Z'))).toBeNull()
  })
})
