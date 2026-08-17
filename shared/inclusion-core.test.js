// INCLUSION-CORE T6 — verification tests.
//
// Locks in the whole point of the feature: a no-strap member who only has
// source='participation' credits (auto-created by un1t-crm's credit-attendance
// cron) still flows through every member-facing surface — challenges standings,
// streaks, and goal progress — because those libs are source-agnostic.
//
// Pure-lib tests only (fixtures, no DB), mirroring challenges.test.js /
// hr-analytics.test.js / the goals test patterns.

import { describe, it, expect } from 'vitest'
import { metricValue } from './challenges.js'
import { currentStreak } from './hr-analytics.js'
import { computeProgress } from './goals.js'

// A participation credit, shaped exactly like un1t-crm's
// live-class.js createParticipationSession() insert: source='participation',
// effort_points = the location's participationPoints, zones_seconds = {},
// started_at + ended_at set, NO peak_hr_bpm / avg_hr_bpm (no strap).
function participationSession(over = {}) {
  return {
    source: 'participation',
    effort_points: 50,
    zones_seconds: {},
    started_at: '2026-06-21T10:00:00Z',
    ended_at: '2026-06-21T11:00:00Z',
    glofox_event_id: 'evt-1',
    class_name: 'RIDE',
    ...over,
  }
}

// ── metricValue: 'classes' counts a participation session as 1 ──────────

describe('metricValue — classes is source-agnostic', () => {
  it("counts a participation session as 1 (not 0)", () => {
    const s = { source: 'participation', effort_points: 50, zones_seconds: {} }
    expect(metricValue(s, 'classes')).toBe(1)
    // The whole inclusion point: it must NOT be filtered out to 0.
    expect(metricValue(s, 'classes')).not.toBe(0)
  })

  it("'points' still reflects the participation effort_points", () => {
    // (sanity — the participation credit also carries points so it shows on
    // the points board too, but the consistency board uses 'classes')
    expect(metricValue({ source: 'participation', effort_points: 50, zones_seconds: {} }, 'points')).toBe(50)
  })
})

// ── currentStreak: participation sessions count as training days ────────

describe('currentStreak — participation counts as a training day', () => {
  const N = new Date('2026-06-21T18:00:00Z').getTime()
  const dayAgo = (n) => new Date(N - n * 24 * 3600 * 1000).toISOString()

  it('counts a participation-shaped session (no peak_hr) on the streak', () => {
    const sessions = [
      participationSession({ started_at: dayAgo(0), ended_at: dayAgo(0) }),
      participationSession({ started_at: dayAgo(1), ended_at: dayAgo(1) }),
      participationSession({ started_at: dayAgo(2), ended_at: dayAgo(2) }),
    ]
    // No peak_hr on any of them — currentStreak keys on started_at only.
    expect(sessions.every((s) => s.peak_hr_bpm === undefined)).toBe(true)
    expect(currentStreak(sessions, N).current).toBe(3)
  })

  it('a single participation session today gives a live streak of 1', () => {
    const r = currentStreak([participationSession({ started_at: dayAgo(0), ended_at: dayAgo(0) })], N)
    expect(r.current).toBe(1)
    expect(r.best).toBe(1)
  })

  it('mixes with HR sessions on the same day without double-counting', () => {
    const sessions = [
      participationSession({ started_at: dayAgo(0), ended_at: dayAgo(0) }),
      { source: 'bridge', peak_hr_bpm: 180, started_at: dayAgo(0), ended_at: dayAgo(0) },
      participationSession({ started_at: dayAgo(1), ended_at: dayAgo(1) }),
    ]
    expect(currentStreak(sessions, N).current).toBe(2)
  })
})

// ── computeProgress: participation session lands in the weekly bucket ───

describe('computeProgress — participation lands in the weekly bucket', () => {
  // Pin "now" to a fixed instant; anchor the session in the same ISO week so
  // the test is deterministic regardless of when it runs.
  const now = new Date('2026-06-21T18:00:00Z') // a Sunday — ISO week began Mon 2026-06-15
  const inThisWeek = '2026-06-17T10:00:00Z'    // Wednesday of that week

  it('counts a participation session toward a weekly_classes goal', () => {
    const goal = { kind: 'weekly_classes', target_value: 3 }
    const sessions = [participationSession({ started_at: inThisWeek, ended_at: '2026-06-17T11:00:00Z' })]
    const p = computeProgress(goal, sessions, now)
    expect(p.current).toBe(1)
    expect(p.def.period).toBe('week')
    // The participation credit's effort_points also flow to a points goal.
    const pts = computeProgress({ kind: 'weekly_points', target_value: 200 }, sessions, now)
    expect(pts.current).toBe(50)
  })

  it('excludes a session from before the week start (bucket boundary works)', () => {
    const goal = { kind: 'weekly_classes', target_value: 3 }
    const lastWeek = participationSession({ started_at: '2026-06-14T10:00:00Z', ended_at: '2026-06-14T11:00:00Z' }) // Sunday before
    const thisWeek = participationSession({ started_at: inThisWeek, ended_at: '2026-06-17T11:00:00Z' })
    expect(computeProgress(goal, [lastWeek, thisWeek], now).current).toBe(1)
  })
})
