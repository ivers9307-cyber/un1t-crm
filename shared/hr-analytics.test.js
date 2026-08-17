// Tests for hr-analytics.js — pure helpers, fixtures only.
// BYTE-SYNC: champ-app/shared/hr-analytics.test.js ↔ un1t-crm/src/lib/hr-analytics.test.js
// (fully identical — both import './hr-analytics.js' relatively). Port tests both ways.

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
  weeklyStreak,
  byStartedDesc,
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
    expect(h.message).toMatch(/red zone/)
    // Customer-facing copy spells the zone out in full — no "Z5" shorthand.
    expect(h.message).toContain('Zone 5')
    expect(h.message).not.toMatch(/\bZ5\b/)
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
  it('renders "top 1%" (never "top 0%") on a best-ever recent session', () => {
    // COPY-BUG regression: percentileOf returns 1 for a best-ever session,
    // so 100 - round(1*100) = 0 → "top 0%". Must clamp to 1.
    // Distinct event type + class so best_class_type_points can't fire.
    const thisSession = s({ id: 'now', eventType: 'evt-NEW', className: 'NEWCLASS', points: 500, peak: 170, zones: { 5: 0 } })
    const history = Array.from({ length: 8 }).map((_, i) =>
      s({ id: `p${i}`, eventType: 'evt-RIDE', startedDaysAgo: 5 + i, points: 50 + i, peak: 170 }),
    )
    const h = pickHighlight({ thisSession, history, nowMs: NOW })
    expect(h.id).toBe('top_quartile_recent')
    expect(h.message).toContain('top 1%')
    expect(h.message).not.toContain('top 0%')
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

// ── highlight streak day boundary is Europe/Dublin, not UTC ──────
describe('pickHighlight streak — Dublin day boundary', () => {
  // A just-after-midnight Dublin session during BST is the PREVIOUS UTC day:
  //   2026-06-19 00:30 Dublin (+1) = 2026-06-18 23:30 UTC.
  // This mix makes UTC vs Dublin diverge:
  //   now : 2026-06-20 12:00 UTC          → Dublin 06-20, UTC 06-20
  //   p1  : 2026-06-19 00:30 Dublin       → Dublin 06-19, UTC 06-18
  //   p2  : 2026-06-18 12:00 UTC          → Dublin 06-18, UTC 06-18
  // DUBLIN days = {20, 19, 18} consecutive → 3-day streak (highlight fires).
  // UTC days    = {20, 18}                → streak breaks at 06-19 → 1 (no fire).
  // So the highlight ONLY appears with the Dublin-day fix — a UTC key mis-counts.
  const dub0030 = (dateStr) => {
    const [y, mo, d] = dateStr.split('-').map(Number)
    return new Date(Date.UTC(y, mo - 1, d, 0, 30) - 3600 * 1000).toISOString() // 00:30 Dublin BST
  }
  it('counts a 3-day Dublin streak that a UTC day boundary would break', () => {
    const thisSession = {
      id: 'now', started_at: '2026-06-20T12:00:00Z',
      class_name: 'RIDE', category: null, effort_points: 10, peak_hr_bpm: 100, avg_hr_bpm: 90, zones_seconds: {},
    }
    const history = [
      { id: 'p1', started_at: dub0030('2026-06-19'), class_name: 'RIDE', effort_points: 10, peak_hr_bpm: 100, zones_seconds: {} },
      { id: 'p2', started_at: '2026-06-18T12:00:00Z', class_name: 'RIDE', effort_points: 10, peak_hr_bpm: 100, zones_seconds: {} },
    ]
    const nowMs = Date.parse('2026-06-20T13:00:00Z')
    const hl = pickHighlight({ thisSession, history, eventTypeName: 'RIDE', nowMs })
    expect(hl?.id).toBe('streak')
    expect(hl.message).toMatch(/3-day streak/)
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

// ── Dublin timezone day bucketing ─────────────────────────────────
//
// A session at 23:45 UTC on a given date is still the SAME Dublin calendar
// day during BST (UTC+1 = 00:45 next day) — but an Irish session at
// 23:30 UTC is 00:30 on the NEXT Dublin day during BST.
// The streak logic must bucket by Dublin local date, not UTC date, so that
// a user who trains at 11:30 pm Dublin time (= 22:30 UTC in winter, 22:30
// UTC-mapped-to-23:30-BST) is not mis-bucketed to the wrong calendar day.

describe('currentStreak — Dublin midnight bucketing', () => {
  // During BST (Irish Summer Time = UTC+1), a UTC timestamp of
  // 2026-06-22T23:30:00Z is 2026-06-23T00:30:00+01:00 in Dublin — i.e.
  // the *next* Dublin calendar day.
  // If we bucket by UTC date we'd see 2026-06-22; Dublin-correct is 2026-06-23.

  it('buckets a BST near-midnight session to the correct Dublin day', () => {
    // "now" = 2026-06-23T12:00:00Z (Dublin: 2026-06-23 13:00 BST)
    const nowMs = new Date('2026-06-23T12:00:00Z').getTime()

    // Session at 23:30 UTC on 2026-06-22 = 00:30 on 2026-06-23 in Dublin (BST).
    // In UTC-date terms this would be 2026-06-22 → wrong. Dublin date = 2026-06-23 = TODAY.
    const sessions = [{ started_at: '2026-06-22T23:30:00Z' }]
    const r = currentStreak(sessions, nowMs)

    // The session is today in Dublin time, so current streak should be 1.
    expect(r.current).toBe(1)
    expect(r.best).toBe(1)
  })

  it('does not over-count a UTC midnight session as the wrong Dublin day', () => {
    // A session at 2026-06-22T22:00:00Z is still 2026-06-22 in Dublin (BST = +1 = 23:00).
    // "now" = 2026-06-23T12:00:00Z
    const nowMs = new Date('2026-06-23T12:00:00Z').getTime()
    const sessions = [
      { started_at: '2026-06-23T09:00:00Z' }, // today both UTC and Dublin
      { started_at: '2026-06-22T22:00:00Z' }, // yesterday in Dublin (22:00 UTC = 23:00 BST, still Jun 22)
    ]
    const r = currentStreak(sessions, nowMs)
    expect(r.current).toBe(2)
    expect(r.best).toBe(2)
  })
})

// ── DST-transition-day streaks ────────────────────────────────────
//
// Ireland springs forward on the last Sunday of March (01:00 GMT →
// 02:00 IST, a 23-hour civil day) and falls back on the last Sunday of
// October (02:00 IST → 01:00 GMT, a 25-hour civil day). A naive
// nowMs - 24h day step drifts an hour and can skip/duplicate a day
// across these Sundays; walking by Dublin calendar day must not.

describe('currentStreak — DST transition days', () => {
  it('spring-forward Sunday 2026-03-29 keeps a 3-day streak intact', () => {
    // Fri 27, Sat 28, Sun 29 (spring-forward). "now" = Sun 29 noon Dublin.
    const nowMs = new Date('2026-03-29T11:00:00Z').getTime() // 12:00 IST
    const sessions = [
      { started_at: '2026-03-27T10:00:00Z' }, // Fri (GMT)
      { started_at: '2026-03-28T10:00:00Z' }, // Sat (GMT)
      { started_at: '2026-03-29T10:00:00Z' }, // Sun (IST, 11:00 Dublin)
    ]
    const r = currentStreak(sessions, nowMs)
    expect(r.current).toBe(3)
    expect(r.best).toBe(3)
  })

  it('spring-forward: a session just after the skipped hour is Sun 29', () => {
    // 01:30 GMT does not exist on 2026-03-29 (skipped); 01:30Z = 02:30 IST
    // is the morning of Sun 29 in Dublin.
    const nowMs = new Date('2026-03-29T20:00:00Z').getTime()
    const sessions = [
      { started_at: '2026-03-28T23:30:00Z' }, // 23:30 GMT = Sat 28 Dublin
      { started_at: '2026-03-29T01:30:00Z' }, // 02:30 IST = Sun 29 Dublin
    ]
    const r = currentStreak(sessions, nowMs)
    expect(r.current).toBe(2)
    expect(r.best).toBe(2)
  })

  it('fall-back Sunday 2026-10-25 keeps a 3-day streak intact', () => {
    // Fri 23, Sat 24, Sun 25 (fall-back). "now" = Sun 25 noon Dublin.
    const nowMs = new Date('2026-10-25T12:00:00Z').getTime() // 12:00 GMT
    const sessions = [
      { started_at: '2026-10-23T10:00:00Z' }, // Fri (IST, 11:00 Dublin)
      { started_at: '2026-10-24T10:00:00Z' }, // Sat (IST)
      { started_at: '2026-10-25T10:00:00Z' }, // Sun (GMT after fall-back)
    ]
    const r = currentStreak(sessions, nowMs)
    expect(r.current).toBe(3)
    expect(r.best).toBe(3)
  })

  it('fall-back: the repeated 01:30 hour maps to one Dublin day (Sun 25)', () => {
    // 00:30Z = 01:30 IST (first pass) and 01:30Z = 01:30 GMT (second pass)
    // both fall on Sun 25 Dublin — one calendar day, so it's a single-day
    // streak, not two.
    const nowMs = new Date('2026-10-25T20:00:00Z').getTime()
    const sessions = [
      { started_at: '2026-10-25T00:30:00Z' }, // 01:30 IST, Sun 25
      { started_at: '2026-10-25T01:30:00Z' }, // 01:30 GMT, still Sun 25
    ]
    const r = currentStreak(sessions, nowMs)
    expect(r.current).toBe(1)
    expect(r.best).toBe(1)
  })
})

describe('weeklyStreak', () => {
  // Anchor mid-week (a Wednesday) so "this week" is unambiguous.
  const NOWW = new Date('2026-05-06T12:00:00Z').getTime() // Wed 6 May 2026
  const WEEK = 7 * 24 * 3600 * 1000
  const weeksAgo = (n) => new Date(NOWW - n * WEEK).toISOString()

  it('returns zeros for no sessions', () => {
    expect(weeklyStreak([], { nowMs: NOWW })).toEqual({
      current: 0, best: 0, thisWeekCount: 0, minPerWeek: 1,
    })
  })

  it('counts consecutive weeks with >=1 session ending this week', () => {
    const ss = [
      { started_at: weeksAgo(0) },
      { started_at: weeksAgo(1) },
      { started_at: weeksAgo(2) },
    ]
    const r = weeklyStreak(ss, { nowMs: NOWW })
    expect(r.current).toBe(3)
    expect(r.thisWeekCount).toBe(1)
  })

  it('grace week: last week counts when this week has no session yet', () => {
    const ss = [
      { started_at: weeksAgo(1) },
      { started_at: weeksAgo(2) },
    ]
    const r = weeklyStreak(ss, { nowMs: NOWW })
    expect(r.current).toBe(2)
    expect(r.thisWeekCount).toBe(0)
  })

  it('breaks the streak on a skipped week', () => {
    const ss = [
      { started_at: weeksAgo(0) },
      // week 1 skipped
      { started_at: weeksAgo(2) },
      { started_at: weeksAgo(3) },
    ]
    const r = weeklyStreak(ss, { nowMs: NOWW })
    expect(r.current).toBe(1)
    expect(r.best).toBe(2)
  })

  it('returns 0 current when the most recent week is older than last week', () => {
    const ss = [{ started_at: weeksAgo(3) }]
    expect(weeklyStreak(ss, { nowMs: NOWW }).current).toBe(0)
  })

  it('honours minPerWeek — a week needs enough sessions to qualify', () => {
    const ss = [
      { started_at: weeksAgo(0) }, // 1 session this week only
      { started_at: weeksAgo(1) },
      { started_at: weeksAgo(1) }, // 2 sessions last week
    ]
    const r = weeklyStreak(ss, { minPerWeek: 2, nowMs: NOWW })
    // This week has only 1 (< 2) → grace to last week, which has 2 → current 1.
    expect(r.current).toBe(1)
    expect(r.minPerWeek).toBe(2)
  })

  it('best captures the longest run anywhere', () => {
    const ss = [
      { started_at: weeksAgo(0) },
      { started_at: weeksAgo(1) }, // run of 2 now
      // gap
      { started_at: weeksAgo(4) },
      { started_at: weeksAgo(5) },
      { started_at: weeksAgo(6) }, // run of 3 earlier
    ]
    const r = weeklyStreak(ss, { nowMs: NOWW })
    expect(r.current).toBe(2)
    expect(r.best).toBe(3)
  })
})

// ── last-8 must be the 8 MOST RECENT (sort before slice) ─────────
// Mirrors the un1t-crm hr-analytics "item 7" tests.

describe('byStartedDesc', () => {
  it('sorts most-recent-first, non-mutating', () => {
    const input = [{ started_at: day(5) }, { started_at: day(1) }, { started_at: day(9) }]
    const out = byStartedDesc(input)
    expect(out.map((r) => r.started_at)).toEqual([day(1), day(5), day(9)])
    expect(input[0].started_at).toBe(day(5)) // original untouched
  })
  it('tolerates empty/null', () => {
    expect(byStartedDesc([])).toEqual([])
    expect(byStartedDesc(null)).toEqual([])
  })
})

describe('buildSessionAnalytics — last-8 determinism', () => {
  it('computes classType mean over the 8 MOST RECENT, not an arbitrary 8', () => {
    // 12 in-window RIDE sessions: the 8 newest all score 100, the 4 OLDEST score
    // 1000. A bare slice(0,8) over unsorted rows could grab the 1000s and blow up
    // the mean; sorting DESC first fixes the mean to the recent 100s.
    const thisSession = s({ id: 'now', startedDaysAgo: 0, points: 100 })
    const recent = Array.from({ length: 8 }, (_, i) => s({ id: `r${i}`, startedDaysAgo: 1 + i, points: 100 }))
    const older = Array.from({ length: 4 }, (_, i) => s({ id: `o${i}`, startedDaysAgo: 20 + i, points: 1000 }))
    // Deliberately interleave so the input order is NOT started_at-sorted.
    const history = [older[0], recent[0], older[1], recent[1], recent[2], older[2], recent[3], recent[4], older[3], recent[5], recent[6], recent[7]]
    const out = buildSessionAnalytics({ thisSession, history, eventTypeName: 'RIDE', nowMs: NOW })
    expect(out.classType.recentCount).toBe(8)
    expect(out.classType.meanPoints).toBe(100) // recent 8, not the 1000s
  })

  it('computes category mean over the 8 MOST RECENT, not an arbitrary 8', () => {
    const cat = (extra) => ({ ...s(extra), category: 'cardio' })
    const thisSession = cat({ id: 'now', startedDaysAgo: 0, points: 100 })
    const recent = Array.from({ length: 8 }, (_, i) => cat({ id: `r${i}`, startedDaysAgo: 1 + i, points: 100 }))
    const older = Array.from({ length: 4 }, (_, i) => cat({ id: `o${i}`, startedDaysAgo: 20 + i, points: 1000 }))
    const history = [older[0], recent[0], older[1], recent[1], recent[2], older[2], recent[3], recent[4], older[3], recent[5], recent[6], recent[7]]
    const out = buildSessionAnalytics({ thisSession, history, eventTypeName: 'RIDE', nowMs: NOW })
    expect(out.category.recentCount).toBe(8)
    expect(out.category.meanPoints).toBe(100)
  })
})
