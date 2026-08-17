import { describe, it, expect } from 'vitest'
import {
  challengeWrappedModel,
  challengeWindowMs,
  endedRecentlyFlagship,
  ownWindowStats,
} from './challenge-wrapped.js'

// A challenge that ran 1–10 June 2026 (Dublin), individual/classes, flagship.
const CH = {
  id: 'ch-1',
  name: 'June Transformation',
  mode: 'individual',
  metric: 'classes',
  starts_on: '2026-06-01',
  ends_on: '2026-06-10',
  is_flagship: true,
}

// Session anchored mid-day so Dublin/UTC agree on the calendar day.
const sOn = (iso, over = {}) => ({
  id: `s-${iso}`,
  started_at: `${iso}T12:00:00Z`,
  ended_at: `${iso}T12:45:00Z`,
  effort_points: 100,
  zones_seconds: { 4: 300, 5: 120 },
  ...over,
})

describe('challengeWindowMs', () => {
  it('is the Dublin day window, end-exclusive (00:00 Dublin after ends_on)', () => {
    const win = challengeWindowMs(CH)
    // 1 June 2026 00:00 IST = 2026-05-31T23:00Z
    expect(new Date(win.fromMs).toISOString()).toBe('2026-05-31T23:00:00.000Z')
    // end-exclusive = 11 June 2026 00:00 IST = 2026-06-10T23:00Z
    expect(new Date(win.toMs).toISOString()).toBe('2026-06-10T23:00:00.000Z')
  })

  it('returns null on missing dates', () => {
    expect(challengeWindowMs({ starts_on: '2026-06-01' })).toBeNull()
    expect(challengeWindowMs(null)).toBeNull()
  })
})

describe('ownWindowStats — own totals in the challenge window', () => {
  it('counts classes + points + metric total for in-window sessions only', () => {
    const sessions = [
      sOn('2026-05-31', { effort_points: 500 }), // before window (Dublin 31 May) — excluded
      sOn('2026-06-03', { effort_points: 120 }),
      sOn('2026-06-08', { effort_points: 80 }),
      sOn('2026-06-11', { effort_points: 999 }), // after window — excluded
    ]
    const now = Date.parse('2026-06-20T12:00:00Z')
    const stats = ownWindowStats(sessions, CH, now)
    expect(stats.classes).toBe(2)
    expect(stats.points).toBe(200) // 120 + 80
    expect(stats.metricTotal).toBe(2) // metric 'classes' → 1 each
  })

  it('excludes future-dated sessions even if inside the calendar window', () => {
    const now = Date.parse('2026-06-05T12:00:00Z') // mid-challenge
    const sessions = [
      sOn('2026-06-03'),
      sOn('2026-06-08'), // after "now" — excluded
    ]
    const stats = ownWindowStats(sessions, CH, now)
    expect(stats.classes).toBe(1)
  })

  it('sums z4plus_minutes when that is the metric', () => {
    const ch = { ...CH, metric: 'z4plus_minutes' }
    const now = Date.parse('2026-06-20T12:00:00Z')
    // zones_seconds {4:300, 5:120} → (300+120)/60 = 7 min per session
    const stats = ownWindowStats([sOn('2026-06-03'), sOn('2026-06-05')], ch, now)
    expect(stats.metricTotal).toBe(14)
  })

  it('returns zeros for empty/missing input without throwing', () => {
    expect(ownWindowStats(null, CH).classes).toBe(0)
    expect(ownWindowStats([], CH).points).toBe(0)
    expect(ownWindowStats([sOn('2026-06-03')], { metric: 'classes' }).classes).toBe(0) // no dates → null window
  })
})

describe('endedRecentlyFlagship — the trigger predicate', () => {
  it('true for a flagship that ended within the last 14 days', () => {
    const now = Date.parse('2026-06-15T12:00:00Z') // 5 days after the 10th
    expect(endedRecentlyFlagship(CH, now, 14)).toBe(true)
  })

  it('false once more than 14 days have passed', () => {
    const now = Date.parse('2026-06-30T12:00:00Z') // 20 days after
    expect(endedRecentlyFlagship(CH, now, 14)).toBe(false)
  })

  it('false while the challenge is still active', () => {
    const now = Date.parse('2026-06-05T12:00:00Z')
    expect(endedRecentlyFlagship(CH, now, 14)).toBe(false)
  })

  it('false when not flagship (falsy/undefined is_flagship stays inert)', () => {
    const now = Date.parse('2026-06-15T12:00:00Z')
    expect(endedRecentlyFlagship({ ...CH, is_flagship: false }, now, 14)).toBe(false)
    expect(endedRecentlyFlagship({ ...CH, is_flagship: undefined }, now, 14)).toBe(false)
  })

  it('never throws on garbage input', () => {
    expect(endedRecentlyFlagship(null)).toBe(false)
    expect(endedRecentlyFlagship({ is_flagship: true })).toBe(false)
  })
})

describe('challengeWrappedModel — the finisher story', () => {
  const now = Date.parse('2026-06-15T12:00:00Z')

  it('builds own stats + rank + finisher for a participant', () => {
    const sessions = [
      sOn('2026-06-02', { effort_points: 150 }),
      sOn('2026-06-06', { effort_points: 90 }),
      sOn('2026-06-09', { effort_points: 60 }),
    ]
    const m = challengeWrappedModel({ challenge: CH, sessions, rank: 3, count: 42, nowMs: now })
    expect(m.hasContent).toBe(true)
    expect(m.name).toBe('June Transformation')
    expect(m.metric).toBe('classes')
    expect(m.metricLabel).toBe('classes')
    expect(m.classes).toBe(3)
    expect(m.points).toBe(300)
    expect(m.metricTotal).toBe(3)
    expect(m.rank).toBe(3)
    expect(m.count).toBe(42)
    expect(m.finisher).toBe(true)
    expect(m.inbody).toBeNull()
  })

  it('hasContent:false when the member did not participate in the window', () => {
    const sessions = [sOn('2026-05-20'), sOn('2026-06-20')] // both outside
    const m = challengeWrappedModel({ challenge: CH, sessions, nowMs: now })
    expect(m.hasContent).toBe(false)
    expect(m.finisher).toBe(false)
  })

  it('hasContent:false for a non-flagship challenge even with participation (guards a direct deep-link)', () => {
    const sessions = [sOn('2026-06-03')]
    expect(challengeWrappedModel({ challenge: { ...CH, is_flagship: false }, sessions, nowMs: now }).hasContent).toBe(false)
    expect(challengeWrappedModel({ challenge: { ...CH, is_flagship: undefined }, sessions, nowMs: now }).hasContent).toBe(false)
  })

  it('hasContent:false while a flagship challenge is still running (no premature finisher)', () => {
    const sessions = [sOn('2026-06-03')]
    const midChallenge = Date.parse('2026-06-05T12:00:00Z') // before the 2026-06-10 close
    expect(challengeWrappedModel({ challenge: CH, sessions, nowMs: midChallenge }).hasContent).toBe(false)
  })

  it('omits rank/count when they are unknown or invalid', () => {
    const m = challengeWrappedModel({ challenge: CH, sessions: [sOn('2026-06-03')], rank: 0, count: -1, nowMs: now })
    expect(m.rank).toBeNull()
    expect(m.count).toBeNull()
  })

  it('surfaces the top improved InBody delta (muscle↑ preferred)', () => {
    const bookend = {
      metrics: [
        { key: 'weight_kg', label: 'Weight', unit: 'kg', dp: 1, delta: -1.2, improved: true },
        { key: 'smm_kg', label: 'Muscle', unit: 'kg', dp: 1, delta: 0.8, improved: true },
        { key: 'pbf_percent', label: 'Body fat', unit: '%', dp: 1, delta: -2.0, improved: true },
      ],
    }
    const m = challengeWrappedModel({ challenge: CH, sessions: [sOn('2026-06-03')], bookend, nowMs: now })
    expect(m.inbody).toEqual({ label: 'Muscle', unit: 'kg', delta: 0.8, dp: 1 })
  })

  it('falls back to body-fat then weight; null when no improved metric', () => {
    const fatOnly = {
      metrics: [
        { key: 'smm_kg', label: 'Muscle', unit: 'kg', dp: 1, delta: -0.5, improved: false },
        { key: 'pbf_percent', label: 'Body fat', unit: '%', dp: 1, delta: -1.5, improved: true },
      ],
    }
    expect(challengeWrappedModel({ challenge: CH, sessions: [sOn('2026-06-03')], bookend: fatOnly, nowMs: now }).inbody)
      .toEqual({ label: 'Body fat', unit: '%', delta: -1.5, dp: 1 })

    const noneImproved = {
      metrics: [{ key: 'smm_kg', label: 'Muscle', unit: 'kg', dp: 1, delta: -0.5, improved: false }],
    }
    expect(challengeWrappedModel({ challenge: CH, sessions: [sOn('2026-06-03')], bookend: noneImproved, nowMs: now }).inbody)
      .toBeNull()
  })

  it('never throws on empty input', () => {
    expect(challengeWrappedModel({}).hasContent).toBe(false)
    expect(challengeWrappedModel().hasContent).toBe(false)
    expect(challengeWrappedModel({ challenge: CH, sessions: null, nowMs: now }).hasContent).toBe(false)
  })
})
