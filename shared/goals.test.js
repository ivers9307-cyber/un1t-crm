// Tests for goals.js — periodEnd, computeProgress.

import { describe, it, expect } from 'vitest'
import {
  startOfIsoWeek,
  startOfMonth,
  periodEnd,
  computeProgress,
  GOAL_DEFS,
} from './goals.js'

// ── periodEnd ─────────────────────────────────────────────────────

describe('periodEnd — week', () => {
  it('returns the Dublin midnight starting the next ISO week', () => {
    const start = startOfIsoWeek(new Date('2026-06-22T10:00:00Z')) // Monday 2026-06-22
    const end = periodEnd('week', start)
    // Week/month boundaries are Europe/Dublin midnights. June is IST
    // (UTC+1), so 00:00 Dublin on Mon 2026-06-29 == 2026-06-28T23:00Z.
    const expectedMs = new Date('2026-06-28T23:00:00Z').getTime()
    expect(end.getTime()).toBe(expectedMs)
  })

  it('periodEnd is different from periodStart', () => {
    const start = startOfIsoWeek(new Date('2026-01-05T00:00:00Z'))
    const end = periodEnd('week', start)
    expect(end.getTime()).toBeGreaterThan(start.getTime())
  })
})

describe('periodEnd — month', () => {
  it('returns the first Dublin midnight of the next month', () => {
    const start = startOfMonth(new Date('2026-06-15T12:00:00Z')) // June (IST)
    const end = periodEnd('month', start)
    // 00:00 Dublin on 2026-07-01 == 2026-06-30T23:00Z (IST, UTC+1).
    const expectedMs = new Date('2026-06-30T23:00:00Z').getTime()
    expect(end.getTime()).toBe(expectedMs)
  })

  it('handles December → January year roll', () => {
    const start = startOfMonth(new Date('2025-12-20T00:00:00Z')) // Dec (GMT)
    const end = periodEnd('month', start)
    // December + January are both GMT (UTC+0), so Dublin midnight == UTC.
    const expectedMs = new Date('2026-01-01T00:00:00Z').getTime()
    expect(end.getTime()).toBe(expectedMs)
  })
})

// ── computeProgress ───────────────────────────────────────────────

// NOW = Wednesday 2026-06-24 18:00 UTC; ISO week started Monday 2026-06-22.
// Sessions 1 day ago (Tuesday) and 2 days ago (Monday) are both in the same week.
const NOW = new Date('2026-06-24T18:00:00Z')

function daysAgo(n) {
  return new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString()
}

function session(overrides) {
  return { started_at: NOW.toISOString(), effort_points: 100, ...overrides }
}

describe('computeProgress — basic', () => {
  const weekClassGoal = { kind: 'weekly_classes', target_value: 3 }

  it('counts sessions within the current week', () => {
    const sessions = [
      session({ started_at: daysAgo(1) }), // Tuesday — same week
      session({ started_at: daysAgo(2) }), // Monday — same week
    ]
    const { current, pct } = computeProgress(weekClassGoal, sessions, NOW)
    expect(current).toBe(2)
    expect(pct).toBeCloseTo(2 / 3, 5)
  })

  it('excludes sessions before the period start', () => {
    const sessions = [
      session({ started_at: daysAgo(8) }), // last week
    ]
    const { current } = computeProgress(weekClassGoal, sessions, NOW)
    expect(current).toBe(0)
  })
})

describe('computeProgress — undated session guard', () => {
  const weekPointsGoal = { kind: 'weekly_points', target_value: 500 }

  it('skips a session with no started_at or ended_at (undefined fields)', () => {
    const sessions = [
      { effort_points: 200 },  // no date fields at all — `new Date(undefined)` → Invalid Date
      session({ started_at: daysAgo(1), effort_points: 150 }), // Tuesday, within week
    ]
    const { current } = computeProgress(weekPointsGoal, sessions, NOW)
    // Only the dated session should count
    expect(current).toBe(150)
  })

  it('skips a session with an unparseable date string', () => {
    const sessions = [
      { started_at: 'not-a-date', effort_points: 999 },
      session({ started_at: daysAgo(1), effort_points: 100 }),
    ]
    const { current } = computeProgress(weekPointsGoal, sessions, NOW)
    expect(current).toBe(100)
  })

  it('skips a session where started_at is null and ended_at is null', () => {
    // new Date(null).getTime() === 0, which is finite but far in the past (before periodStart).
    // The guard (Number.isFinite) still protects via the t < startMs check for null;
    // but the explicit isFinite guard is needed for undefined/NaN (unparseable strings).
    const sessions = [
      { started_at: null, ended_at: null, effort_points: 777 },
      session({ effort_points: 50 }),
    ]
    const { current } = computeProgress(weekPointsGoal, sessions, NOW)
    // null-dated session: new Date(null).getTime()=0 < startMs → skipped by period filter
    // undefined-dated session (no field): new Date(undefined).getTime()=NaN → skipped by isFinite guard
    expect(current).toBe(50)
  })
})
