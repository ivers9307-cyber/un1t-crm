// Tests for hr-analytics.js — pure helpers, fixtures only.

import { describe, it, expect } from 'vitest'
import {
  sameClassType,
  withinDays,
  inWindow,
  meanField,
  percentileOf,
  trendDelta,
  pickHighlight,
  buildSessionAnalytics,
  currentStreak,
} from './hr-analytics.js'

const NOW = new Date('2026-05-08T18:00:00Z').getTime()
const day = (n) => new Date(NOW - n * 24 * 3600 * 1000).toISOString()

function s({ id = 'x', startedDaysAgo = 0, eventType = 'evt-RIDE', className = 'RIDE', points = 100, peak = 170, avg = 140, zones = { 1: 60, 2: 600, 3: 1200, 4: 600, 5: 0 } }) {
  return {
    id, started_at: day(startedDaysAgo),
    event_type_id: eventType,
    class_name: className,
    effort_points: points, peak_hr_bpm: peak, avg_hr_bpm: avg,
    zones_seconds: zones,
  }
}

// ── windows ──────────────────────────────────────────────────────

describe('sameClassType', () => {
  it('filters by event_type_id', () => {
    const all = [s({ id: 'a', eventType: 'evt-RIDE' }), s({ id: 'b', eventType: 'evt-HIIT' })]
    expect(sameClassType(all, 'evt-RIDE').map((x) => x.id)).toEqual(['a'])
  })
  it('returns [] for empty event type', () => {
    expect(sameClassType([s({})], null)).toEqual([])
  })
})

describe('withinDays', () => {
  it('keeps sessions within N days of now', () => {
    const all = [s({ id: 'a', startedDaysAgo: 3 }), s({ id: 'b', startedDaysAgo: 30 })]
    expect(withinDays(all, 7, NOW).map((x) => x.id)).toEqual(['a'])
  })
})

describe('inWindow', () => {
  it('keeps sessions strictly between two day-offsets', () => {
    const all = [
      s({ id: 'a', startedDaysAgo: 5 }),    // recent — outside window
      s({ id: 'b', startedDaysAgo: 30 }),   // inside [28, 56)
      s({ id: 'c', startedDaysAgo: 60 }),   // too old
    ]
    // Window is older than recent (28..56)
    expect(inWindow(all, 56, 28, NOW).map((x) => x.id)).toEqual(['b'])
  })
})

// ── aggregates ───────────────────────────────────────────────────

describe('meanField', () => {
  it('averages a numeric field, ignoring non-finite', () => {
    expect(meanField([{ x: 10 }, { x: 20 }, { x: 'foo' }], 'x')).toBe(15)
  })
  it('returns null on empty input', () => {
    expect(meanField([], 'x')).toBe(null)
    expect(meanField([{ x: NaN }], 'x')).toBe(null)
  })
})

describe('percentileOf', () => {
  it('returns 1 when value beats every sample', () => {
    const pct = percentileOf(100, [{ p: 10 }, { p: 20 }, { p: 30 }], 'p')
    expect(pct).toBe(1)
  })
  it('returns 0 when value is worst', () => {
    const pct = percentileOf(5, [{ p: 10 }, { p: 20 }, { p: 30 }], 'p')
    expect(pct).toBe(0)
  })
  it('handles ties using midrank', () => {
    // value tied with one of three samples → (2 below + 0.5 tied) / 3 ≈ 0.83
    const pct = percentileOf(20, [{ p: 10 }, { p: 20 }, { p: 30 }], 'p')
    expect(pct).toBeCloseTo((1 + 0.5) / 3, 5)
  })
  it('null on empty sample', () => {
    expect(percentileOf(100, [], 'p')).toBe(null)
    expect(percentileOf(NaN, [{ p: 10 }], 'p')).toBe(null)
  })
})

// ── trend ───────────────────────────────────────────────────────

describe('trendDelta', () => {
  it('flags hasEnoughData=false on too-small samples', () => {
    const out = trendDelta([s({ id: 'a', startedDaysAgo: 5 })], 'effort_points', NOW)
    expect(out.hasEnoughData).toBe(false)
  })
  it('detects up-trend', () => {
    const all = [
      // Recent (last 28d): 200, 200
      s({ id: 'a', startedDaysAgo: 5,  points: 200 }),
      s({ id: 'b', startedDaysAgo: 10, points: 200 }),
      // Prior (28-56d): 100, 100
      s({ id: 'c', startedDaysAgo: 35, points: 100 }),
      s({ id: 'd', startedDaysAgo: 40, points: 100 }),
    ]
    const out = trendDelta(all, 'effort_points', NOW)
    expect(out.hasEnoughData).toBe(true)
    expect(out.direction).toBe('up')
    expect(out.deltaPct).toBeCloseTo(1.0, 5)
  })
  it('flat when within ±5%', () => {
    const all = [
      s({ id: 'a', startedDaysAgo: 5,  points: 100 }),
      s({ id: 'b', startedDaysAgo: 10, points: 102 }),
      s({ id: 'c', startedDaysAgo: 35, points: 100 }),
      s({ id: 'd', startedDaysAgo: 40, points: 99 }),
    ]
    expect(trendDelta(all, 'effort_points', NOW).direction).toBe('flat')
  })
  it('detects down-trend', () => {
    const all = [
      s({ id: 'a', startedDaysAgo: 5,  points: 60 }),
      s({ id: 'b', startedDaysAgo: 10, points: 60 }),
      s({ id: 'c', startedDaysAgo: 35, points: 100 }),
      s({ id: 'd', startedDaysAgo: 40, points: 100 }),
    ]
    expect(trendDelta(all, 'effort_points', NOW).direction).toBe('down')
  })
})

// ── highlight picker ───────────────────────────────────────────

describe('pickHighlight', () => {
  it('first_ever for a brand-new member', () => {
    const h = pickHighlight({ thisSession: s({ id: 'now' }), history: [], nowMs: NOW })
    expect(h.id).toBe('first_ever')
  })
  it('first_z5 when prior history has no Z5', () => {
    const thisSession = s({ id: 'now', zones: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 90 } })
    const history = [s({ id: 'p1', zones: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } })]
    const h = pickHighlight({ thisSession, history, nowMs: NOW })
    expect(h.id).toBe('first_z5')
    expect(h.message).toMatch(/red zone|Z5/)
  })
  it('new_peak when this session beats every prior peak', () => {
    const thisSession = s({ id: 'now', peak: 195, zones: { 5: 0 } })
    const history = [
      s({ id: 'p1', peak: 170 }),
      s({ id: 'p2', peak: 175 }),
    ]
    const h = pickHighlight({ thisSession, history, nowMs: NOW })
    expect(h.id).toBe('new_peak')
    expect(h.message).toMatch(/195/)
  })
  it('best_class_type_points when this session tops the same-type history', () => {
    const thisSession = s({ id: 'now', points: 250, peak: 170, zones: { 5: 0 } })
    const history = [
      s({ id: 'p1', points: 100 }),
      s({ id: 'p2', points: 120 }),
      s({ id: 'p3', points: 110 }),
    ]
    const h = pickHighlight({ thisSession, history, eventTypeName: 'RIDE', nowMs: NOW })
    expect(h.id).toBe('best_class_type_points')
    expect(h.message).toMatch(/RIDE/)
  })
  it('top_quartile_recent when this session is high vs last 28d', () => {
    // Use a different event type + class name for this session so best_class_type_points
    // can't fire (its sample-of-2-or-more rule won't be met).
    const thisSession = s({ id: 'now', eventType: 'evt-NEW', className: 'NEWCLASS', points: 200, peak: 170, zones: { 5: 0 } })
    const history = Array.from({ length: 8 }).map((_, i) =>
      s({ id: `p${i}`, eventType: 'evt-RIDE', startedDaysAgo: 5 + i, points: 50 + i, peak: 170 }),
    )
    // Pin the clock to NOW so the recent-28d window matches the
    // fixtures (which are dated relative to NOW). Without nowMs the
    // function uses real Date.now() and the fixtures fall outside
    // the window once `NOW` is > 28 days behind today, which is
    // exactly the flake that bit CI on this test in May 2026.
    const h = pickHighlight({ thisSession, history, nowMs: NOW })
    expect(h.id).toBe('top_quartile_recent')
  })
  it('returns null when no rule fires', () => {
    const thisSession = s({ id: 'now', points: 50, peak: 150, zones: { 5: 0 } })
    const history = Array.from({ length: 10 }).map((_, i) =>
      s({ id: `p${i}`, startedDaysAgo: 5 + i, points: 100, peak: 170 }),
    )
    expect(pickHighlight({ thisSession, history, nowMs: NOW })).toBe(null)
  })
})

// ── buildSessionAnalytics ──────────────────────────────────────

describe('buildSessionAnalytics', () => {
  it('returns the full shape with class-type + overall trend', () => {
    const thisSession = s({ id: 'now', points: 150, peak: 175, zones: { 5: 0 } })
    const history = Array.from({ length: 10 }).map((_, i) =>
      s({ id: `p${i}`, startedDaysAgo: 5 + i, points: 100, peak: 170 }),
    )
    const out = buildSessionAnalytics({ thisSession, history, eventTypeName: 'RIDE', nowMs: NOW })
    expect(out.highlight).toBeTruthy()
    expect(out.classType.eventTypeName).toBe('RIDE')
    expect(out.classType.thisPoints).toBe(150)
    expect(out.classType.meanPoints).toBeGreaterThan(0)
    expect(out.classType.percentile).toBeGreaterThanOrEqual(0)
    expect(out.overall.pointsTrend.direction).toMatch(/up|flat|down/)
  })
})

describe('buildSessionAnalytics — category grouping', () => {
  const base = (over) => ({ id: 'x', started_at: day(2), class_name: 'RIDE', category: 'cardio', effort_points: 100, peak_hr_bpm: 170, avg_hr_bpm: 140, zones_seconds: { 1: 60, 2: 600, 3: 1200, 4: 600, 5: 0 }, ...over })

  it('groups vs_category by category, not class, and ignores other categories', () => {
    const thisSession = base({ id: 'now', startedDaysAgo: 0, started_at: day(0), effort_points: 300 })
    const history = [
      base({ id: 'c1', started_at: day(3), class_name: 'RIDE', category: 'cardio', effort_points: 200 }),
      base({ id: 'c2', started_at: day(5), class_name: 'TEMPO', category: 'cardio', effort_points: 220 }),
      base({ id: 's1', started_at: day(4), class_name: 'LIFT', category: 'strength', effort_points: 999 }),
    ]
    const a = buildSessionAnalytics({ thisSession, history, eventTypeName: 'RIDE', nowMs: NOW })
    // category = cardio over c1 + c2 (the strength row excluded)
    expect(a.category).toMatchObject({ categoryName: 'cardio', recentCount: 2, meanPoints: 210 })
    expect(a.category.percentile).toBe(1) // 300 beats both 200 + 220
    // vs_this_class = RIDE only (c1), not TEMPO/LIFT
    expect(a.classType.recentCount).toBe(1)
    expect(a.classType.meanPoints).toBe(200)
  })

  it('returns null category when this session has none', () => {
    const thisSession = base({ id: 'now', started_at: day(0), category: null })
    const a = buildSessionAnalytics({ thisSession, history: [], eventTypeName: 'RIDE', nowMs: NOW })
    expect(a.category).toBeNull()
  })
})

describe('currentStreak', () => {
  const N = new Date('2026-06-20T18:00:00Z').getTime()
  const dayAgo = (n) => new Date(N - n * 24 * 3600 * 1000).toISOString()

  it('returns 0/0 for no sessions', () => {
    expect(currentStreak([], N)).toEqual({ current: 0, best: 0, lastDayMs: null })
  })
  it('counts consecutive days ending today', () => {
    const ss = [{ started_at: dayAgo(0) }, { started_at: dayAgo(1) }, { started_at: dayAgo(2) }]
    expect(currentStreak(ss, N).current).toBe(3)
  })
  it('is live with a one-day gap (trained yesterday, not today)', () => {
    const ss = [{ started_at: dayAgo(1) }, { started_at: dayAgo(2) }]
    expect(currentStreak(ss, N).current).toBe(2)
  })
  it('is broken if last session is 2+ days ago', () => {
    const ss = [{ started_at: dayAgo(2) }, { started_at: dayAgo(3) }]
    expect(currentStreak(ss, N).current).toBe(0)
  })
  it('dedupes multiple sessions on the same day', () => {
    const ss = [{ started_at: dayAgo(0) }, { started_at: dayAgo(0) }, { started_at: dayAgo(1) }]
    expect(currentStreak(ss, N).current).toBe(2)
  })
  it('reports best run even when current streak is broken', () => {
    const ss = [{ started_at: dayAgo(5) }, { started_at: dayAgo(6) }, { started_at: dayAgo(7) }, { started_at: dayAgo(8) }]
    const r = currentStreak(ss, N)
    expect(r.current).toBe(0)
    expect(r.best).toBe(4)
  })
  it('single old session: current 0, best 1', () => {
    const r = currentStreak([{ started_at: dayAgo(5) }], N)
    expect(r.current).toBe(0)
    expect(r.best).toBe(1)
  })
  it('single session today: current 1, best 1', () => {
    const r = currentStreak([{ started_at: dayAgo(0) }], N)
    expect(r.current).toBe(1)
    expect(r.best).toBe(1)
  })
})
