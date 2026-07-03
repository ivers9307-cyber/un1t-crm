import { describe, it, expect } from 'vitest'
import {
  DEFAULT_JOURNEY_WINDOW_DAYS,
  DEFAULT_JOURNEY_TARGET_CLASSES,
  resolveJourneyConfig,
  journeyStatus,
  buildOnboardingPacePush,
} from './onboarding-journey'

// ---------------------------------------------------------------------------
// Fixtures. May–June 2026 is IST (Dublin = UTC+1), so the Dublin-day
// bucketing genuinely differs from UTC-day bucketing for late-evening
// instants — several tests below lean on that.

/** Join instant whose Dublin day is 2026-05-01. */
const JOINED = '2026-05-01T10:00:00Z'

/** UTC ms for "day N of the journey" (12:00 UTC = 13:00 Dublin, same day). */
const atDay = (n, hourUtc = 12) => Date.UTC(2026, 4, 1 + n, hourUtc, 0, 0)

/** ISO attendance timestamp on journey day N (17:00 UTC = 18:00 Dublin). */
const attIso = (n) => new Date(atDay(n, 17)).toISOString()

/** N attendances on days 1..N (one per day). */
const attendances = (n) => Array.from({ length: n }, (_, i) => attIso(i + 1))

describe('resolveJourneyConfig', () => {
  it('defaults to 42 days / 9 classes when no config', () => {
    expect(resolveJourneyConfig(null)).toEqual({ windowDays: 42, targetClasses: 9 })
    expect(resolveJourneyConfig({})).toEqual({ windowDays: 42, targetClasses: 9 })
    expect(resolveJourneyConfig({ notification_config: null })).toEqual({ windowDays: 42, targetClasses: 9 })
    expect(resolveJourneyConfig({ notification_config: { categories: {} } }))
      .toEqual({ windowDays: 42, targetClasses: 9 })
    expect(DEFAULT_JOURNEY_WINDOW_DAYS).toBe(42)
    expect(DEFAULT_JOURNEY_TARGET_CLASSES).toBe(9)
  })

  it('reads a per-location override (28 days / 6 classes)', () => {
    const location = {
      notification_config: {
        categories: { onboarding_pace: { window_days: 28, target_classes: 6 } },
      },
    }
    expect(resolveJourneyConfig(location)).toEqual({ windowDays: 28, targetClasses: 6 })
  })

  it('merges per-field: one valid override, the other defaulted', () => {
    const location = {
      notification_config: { categories: { onboarding_pace: { window_days: 56 } } },
    }
    expect(resolveJourneyConfig(location)).toEqual({ windowDays: 56, targetClasses: 9 })
  })

  it('falls back per-field on invalid values (negative, non-numeric, out of bounds)', () => {
    const bad = (onboarding_pace) => resolveJourneyConfig({
      notification_config: { categories: { onboarding_pace } },
    })
    expect(bad({ window_days: -5, target_classes: 'x' })).toEqual({ windowDays: 42, targetClasses: 9 })
    expect(bad({ window_days: 0, target_classes: 0 })).toEqual({ windowDays: 42, targetClasses: 9 })
    expect(bad({ window_days: 9999, target_classes: 9999 })).toEqual({ windowDays: 42, targetClasses: 9 })
    expect(bad({ window_days: '28', target_classes: '6' })).toEqual({ windowDays: 28, targetClasses: 6 })
  })
})

describe('journeyStatus — day boundaries', () => {
  const run = (opts) => journeyStatus({ joinedAt: JOINED, attendedAt: [], ...opts })

  it('day 0: in window, on_track (grace), expected 0, week 1', () => {
    const s = run({ now: atDay(0) })
    expect(s).toMatchObject({
      inWindow: true, dayIndex: 0, weekIndex: 1,
      attended: 0, target: 9, expectedByNow: 0, status: 'on_track',
    })
  })

  it('day 6 with zero attendance: still on_track (days 0–6 grace)', () => {
    const s = run({ now: atDay(6) })
    expect(s.dayIndex).toBe(6)
    expect(s.status).toBe('on_track')
  })

  it('day 7 with zero attendance: grace over → behind', () => {
    const s = run({ now: atDay(7) })
    expect(s.dayIndex).toBe(7)
    expect(s.weekIndex).toBe(2)
    expect(s.expectedByNow).toBe(1) // floor(7/42*9) = 1
    expect(s.status).toBe('behind')
  })

  it('day 42: last day of the window — still inWindow', () => {
    const s = run({ now: atDay(42), attendedAt: [attIso(38), attIso(39), attIso(40), attIso(41)].concat(attendances(4)) })
    expect(s.dayIndex).toBe(42)
    expect(s.inWindow).toBe(true)
    expect(s.expectedByNow).toBe(9)
    expect(s.status).toBe('behind') // 8 attended < 9 expected, > expected−2
  })

  it('day 43: expired, not inWindow', () => {
    const s = run({ now: atDay(43), attendedAt: [attIso(40), attIso(41), attIso(42)] })
    expect(s.dayIndex).toBe(43)
    expect(s.inWindow).toBe(false)
    expect(s.status).toBe('expired')
  })

  it('clamps a future joined_at to day 0 (on_track)', () => {
    const s = journeyStatus({ joinedAt: new Date(atDay(5)).toISOString(), attendedAt: [], now: atDay(0) })
    expect(s.dayIndex).toBe(0)
    expect(s.status).toBe('on_track')
  })

  it('returns null for a missing/unparseable joinedAt', () => {
    expect(journeyStatus({ joinedAt: null, attendedAt: [], now: atDay(1) })).toBeNull()
    expect(journeyStatus({ joinedAt: 'garbage', attendedAt: [], now: atDay(1) })).toBeNull()
  })
})

describe('journeyStatus — expected floor + count statuses', () => {
  it('day 21: expectedByNow = 4 (floor(21/42*9) = floor(4.5))', () => {
    const s = journeyStatus({
      joinedAt: JOINED,
      attendedAt: [attIso(15), attIso(17), attIso(19), attIso(20)], // recent — quiet rule stays out
      now: atDay(21),
    })
    expect(s.expectedByNow).toBe(4)
    expect(s.status).toBe('on_track') // 4 ≥ 4, recent attendance
  })

  it('attended 2 when expected 4 → at_risk (≤ expected − 2)', () => {
    const s = journeyStatus({
      joinedAt: JOINED,
      attendedAt: [attIso(18), attIso(19)], // recent, so the quiet rule stays out of it
      now: atDay(21),
    })
    expect(s.attended).toBe(2)
    expect(s.status).toBe('at_risk')
  })

  it('attended 3 when expected 4 → behind (< expected but > expected − 2)', () => {
    const s = journeyStatus({
      joinedAt: JOINED,
      attendedAt: [attIso(17), attIso(19), attIso(20)],
      now: atDay(21),
    })
    expect(s.attended).toBe(3)
    expect(s.status).toBe('behind')
  })

  it('completed once attended ≥ target, even mid-window', () => {
    const s = journeyStatus({ joinedAt: JOINED, attendedAt: attendances(9), now: atDay(20) })
    expect(s.attended).toBe(9)
    expect(s.inWindow).toBe(true)
    expect(s.status).toBe('completed')
  })

  it('completed beats expired after the window closes', () => {
    const s = journeyStatus({ joinedAt: JOINED, attendedAt: attendances(9), now: atDay(43) })
    expect(s.inWindow).toBe(false)
    expect(s.status).toBe('completed')
  })

  it('ignores unparseable attendance entries', () => {
    const s = journeyStatus({
      joinedAt: JOINED,
      attendedAt: ['garbage', null, undefined, attIso(20)],
      now: atDay(21),
    })
    expect(s.attended).toBe(1)
    expect(s.lastAttendedAt).toBe(attIso(20))
  })
})

describe('journeyStatus — 10-day-quiet at-risk rule (Dublin days)', () => {
  it('on pace by count but 10+ Dublin days quiet → at_risk', () => {
    // 5 attended ≥ expected 4, but last attendance was day 11 → 10 quiet days.
    const s = journeyStatus({
      joinedAt: JOINED,
      attendedAt: [attIso(2), attIso(4), attIso(6), attIso(8), attIso(11)],
      now: atDay(21),
    })
    expect(s.attended).toBe(5)
    expect(s.daysSinceLastAttended).toBe(10)
    expect(s.status).toBe('at_risk')
  })

  it('9 quiet days is not at_risk', () => {
    const s = journeyStatus({
      joinedAt: JOINED,
      attendedAt: [attIso(2), attIso(4), attIso(6), attIso(8), attIso(12)],
      now: atDay(21),
    })
    expect(s.daysSinceLastAttended).toBe(9)
    expect(s.status).toBe('on_track')
  })

  it('never attended: quiet rule arms at day 10, not day 9', () => {
    const day9 = journeyStatus({ joinedAt: JOINED, attendedAt: [], now: atDay(9) })
    expect(day9.status).toBe('behind') // expected 1, attended 0
    const day10 = journeyStatus({ joinedAt: JOINED, attendedAt: [], now: atDay(10) })
    expect(day10.status).toBe('at_risk')
  })

  it('buckets by Dublin day, not UTC day', () => {
    // 23:30 UTC on May 10 is 00:30 IST on May 11 → Dublin day 2026-05-11.
    // From May 20 that is 9 Dublin days quiet (safe); a UTC-day bucketer
    // would count 10 and wrongly flag at_risk.
    const s = journeyStatus({
      joinedAt: JOINED,
      attendedAt: [attIso(2), attIso(4), attIso(6), attIso(8), '2026-05-10T23:30:00Z'],
      now: atDay(19), // 2026-05-20 Dublin
    })
    expect(s.daysSinceLastAttended).toBe(9)
    expect(s.status).toBe('on_track') // attended 5 ≥ expected floor(19/42*9)=4
  })

  it('join instant is bucketed by Dublin day too', () => {
    // Joined 23:30 UTC May 1 = 00:30 Dublin May 2 → day 0 is May 2.
    const s = journeyStatus({
      joinedAt: '2026-05-01T23:30:00Z',
      attendedAt: [],
      now: Date.parse('2026-05-02T10:00:00Z'),
    })
    expect(s.dayIndex).toBe(0)
    expect(s.status).toBe('on_track')
  })
})

describe('journeyStatus — config overrides + week index', () => {
  const config = { windowDays: 28, targetClasses: 6 }

  it('applies a 28/6 override to the expected floor', () => {
    const s = journeyStatus({
      joinedAt: JOINED,
      attendedAt: [attIso(15), attIso(17), attIso(19), attIso(20)], // recent
      now: atDay(21),
      config,
    })
    expect(s.target).toBe(6)
    expect(s.windowDays).toBe(28)
    expect(s.expectedByNow).toBe(4) // floor(21/28*6) = floor(4.5)
    expect(s.status).toBe('on_track')
  })

  it('expires past the shorter window', () => {
    const s = journeyStatus({ joinedAt: JOINED, attendedAt: attendances(3), now: atDay(29), config })
    expect(s.inWindow).toBe(false)
    expect(s.status).toBe('expired')
  })

  it('weekIndex is 1-based and capped at the window total', () => {
    const wk = (day, cfg) => journeyStatus({
      joinedAt: JOINED, attendedAt: attendances(9), now: atDay(day), config: cfg,
    }).weekIndex
    expect(wk(0)).toBe(1)
    expect(wk(6)).toBe(1)
    expect(wk(7)).toBe(2)
    expect(wk(41)).toBe(6)
    expect(wk(42)).toBe(6) // capped: ceil(42/7) = 6 weeks
    expect(wk(27, config)).toBe(4)
    expect(wk(28, config)).toBe(4) // capped: ceil(28/7) = 4 weeks
  })

  it('expectedByNow never exceeds the target', () => {
    const s = journeyStatus({ joinedAt: JOINED, attendedAt: attendances(9), now: atDay(43) })
    expect(s.expectedByNow).toBe(9)
  })
})

describe('buildOnboardingPacePush', () => {
  const STATUSES = ['on_track', 'behind', 'at_risk', 'completed', 'expired', 'nonsense', undefined]

  it('returns { title, body, data.type: onboarding_pace } for every status', () => {
    for (const status of STATUSES) {
      const push = buildOnboardingPacePush({ status, attended: 3, target: 9, weekIndex: 2 })
      expect(push.title, `title for ${status}`).toBeTruthy()
      expect(push.body, `body for ${status}`).toBeTruthy()
      expect(typeof push.title).toBe('string')
      expect(typeof push.body).toBe('string')
      expect(push.data).toEqual({ type: 'onboarding_pace' })
    }
  })

  it('contains ZERO booking language in any variant (hard constraint)', () => {
    for (const status of STATUSES) {
      const push = buildOnboardingPacePush({ status, attended: 3, target: 9, weekIndex: 2 })
      const copy = `${push.title} ${push.body}`
      expect(copy, `booking language in ${status} variant: "${copy}"`).not.toMatch(/book/i)
    }
  })

  it('varies copy by status', () => {
    const behind = buildOnboardingPacePush({ status: 'behind', attended: 3, target: 9 })
    const atRisk = buildOnboardingPacePush({ status: 'at_risk', attended: 3, target: 9 })
    expect(behind.body).not.toBe(atRisk.body)
  })

  it('mentions the progress counts in the behind variant', () => {
    const push = buildOnboardingPacePush({ status: 'behind', attended: 3, target: 9 })
    expect(push.body).toContain('3')
    expect(push.body).toContain('9')
  })

  it('never renders undefined/NaN with a missing row', () => {
    for (const row of [{}, null, undefined, { status: 'behind' }]) {
      const push = buildOnboardingPacePush(row)
      const copy = `${push.title} ${push.body}`
      expect(copy).not.toMatch(/undefined|NaN|null/)
      expect(copy).not.toMatch(/book/i)
    }
  })
})

describe('journeyStatus — completion tracking (completedAt / completedDaysAgo)', () => {
  it('is null until the target is reached', () => {
    const s = journeyStatus({ joinedAt: JOINED, attendedAt: attendances(8), now: atDay(20) })
    expect(s.attended).toBe(8)
    expect(s.status).not.toBe('completed')
    expect(s.completedAt).toBeNull()
    expect(s.completedDaysAgo).toBeNull()
  })

  it('dates completion at the target-th attendance chronologically, not the last', () => {
    // 9 attendances on days 1..9; the 9th (Dublin 2026-05-10) crossed the line.
    // now = journey day 20 (Dublin 2026-05-21) → completed 11 Dublin days ago.
    const s = journeyStatus({ joinedAt: JOINED, attendedAt: attendances(9), now: atDay(20) })
    expect(s.status).toBe('completed')
    expect(s.completedAt).toBe(new Date(atDay(9, 17)).toISOString())
    expect(s.completedDaysAgo).toBe(11)
  })

  it('ignores attendances beyond the target when dating completion', () => {
    const s = journeyStatus({ joinedAt: JOINED, attendedAt: attendances(12), now: atDay(12) })
    expect(s.status).toBe('completed')
    expect(s.completedAt).toBe(new Date(atDay(9, 17)).toISOString())
    expect(s.completedDaysAgo).toBe(3)
  })

  it('dates completion from the target-th even when attendances arrive out of order', () => {
    const shuffled = [attIso(9), attIso(2), attIso(5), attIso(1), attIso(8), attIso(4), attIso(7), attIso(3), attIso(6)]
    const s = journeyStatus({ joinedAt: JOINED, attendedAt: shuffled, now: atDay(15) })
    expect(s.status).toBe('completed')
    expect(s.completedAt).toBe(new Date(atDay(9, 17)).toISOString())
    expect(s.completedDaysAgo).toBe(6)
  })

  it('respects a reduced target for the completion instant', () => {
    const s = journeyStatus({ joinedAt: JOINED, attendedAt: attendances(8), now: atDay(10), config: { targetClasses: 6 } })
    expect(s.status).toBe('completed')
    expect(s.completedAt).toBe(new Date(atDay(6, 17)).toISOString())
    expect(s.completedDaysAgo).toBe(4)
  })
})
