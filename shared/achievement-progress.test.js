// Parity tests for shared/achievement-progress.js against the real award
// evaluator un1t-crm/src/lib/achievements.js.
//
// Why we don't import the real detector: un1t-crm/src/lib/achievements.js
// imports '@/lib/log' and '@/lib/select-all' at module top-level. Under
// champ-app's vitest, '@' aliases to champ-app/src (vitest.config.js), so
// those specifiers can't resolve and the import throws before any detector
// is reachable. Instead we REPLICATE the detector's exact fire condition
// inline (detectAggregateThreshold: `total >= threshold`; detectStreak:
// live-run of consecutive UTC days ≥ requiredDays) and assert our
// ruleProgress() agrees with it at every boundary. The inline replicas
// below are copied verbatim from that file's detector bodies.

import { describe, it, expect } from 'vitest'
import { memberAchievementStats, ruleProgress, sessionMetric } from './achievement-progress.js'

// ── Inline replicas of the real detectors' fire conditions ───────────────────
// (verbatim logic from un1t-crm/src/lib/achievements.js)

const MS_PER_DAY = 24 * 3600 * 1000
function zonesSecondsSafe(s) { return s?.zones_seconds || {} }

// detectAggregateThreshold: fires iff the summed field >= threshold.
function realAggregateFires(sessions, cfg, nowMs) {
  const field = String(cfg.field || '')
  const period = String(cfg.period || 'all_time')
  const threshold = Number(cfg.threshold) || 0
  if (!field || threshold <= 0) return false
  const start = (() => {
    const ref = new Date(nowMs)
    if (period === 'week') {
      const d = new Date(ref)
      const day = (d.getUTCDay() + 6) % 7
      d.setUTCHours(0, 0, 0, 0)
      d.setUTCDate(d.getUTCDate() - day)
      return d
    }
    if (period === 'month') return new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1))
    if (period === 'year') return new Date(Date.UTC(ref.getUTCFullYear(), 0, 1))
    return null
  })()
  const total = sessions.reduce((a, s) => {
    if (start) {
      const t = new Date(s.started_at || s.ended_at).getTime()
      if (t < start.getTime()) return a
    }
    return a + sessionMetric(s, field)
  }, 0)
  return total >= threshold
}

// detectStreak: builds most-recent-first unique UTC day list; unlocks iff the
// run of consecutive days (each exactly 1 day apart) from the most recent day,
// which must be within gap_tolerance_days of today, reaches requiredDays.
function realStreakFires(sessions, cfg, nowMs) {
  const requiredDays = Number(cfg.days) || 0
  const gapTolerance = Number(cfg.gap_tolerance_days) || 0
  if (requiredDays < 2) return false
  const sortedDays = sessions
    .map((s) => {
      const d = new Date(s.started_at || s.ended_at)
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).getTime()
    })
    .sort((a, b) => b - a)
  const uniq = []
  for (const ms of sortedDays) if (uniq[uniq.length - 1] !== ms) uniq.push(ms)
  if (uniq.length < requiredDays) return false
  const nd = new Date(nowMs)
  const todayUtc = new Date(Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth(), nd.getUTCDate())).getTime()
  if ((todayUtc - uniq[0]) / MS_PER_DAY > gapTolerance) return false
  let streak = 1
  for (let i = 1; i < uniq.length; i++) {
    if ((uniq[i - 1] - uniq[i]) / MS_PER_DAY === 1) streak++
    else break
    if (streak >= requiredDays) return true
  }
  return streak >= requiredDays
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// A "class" session = 1 toward the `classes` field, regardless of zones.
function classSession(dateIso, extra = {}) {
  return { started_at: dateIso, ended_at: dateIso, effort_points: 0, zones_seconds: {}, ...extra }
}
// Day sessions on distinct UTC days for streak fixtures.
function daySession(yyyy_mm_dd) {
  return classSession(`${yyyy_mm_dd}T12:00:00.000Z`)
}

const NOW = Date.parse('2026-07-03T12:00:00.000Z')

// ── aggregate_threshold (classes ≥ 5) ────────────────────────────────────────

describe('aggregate_threshold: classes ≥ 5', () => {
  const rule = { rule_type: 'aggregate_threshold', rule_config: { field: 'classes', period: 'all_time', threshold: 5 } }

  it('4/5 → ratio 0.8, quantifiable, and the real detector does NOT fire', () => {
    const sessions = [1, 2, 3, 4].map((n) => classSession(`2026-06-0${n}T12:00:00Z`))
    const stats = memberAchievementStats(sessions, NOW)
    const p = ruleProgress(rule, stats)
    expect(p.quantifiable).toBe(true)
    expect(p.current).toBe(4)
    expect(p.target).toBe(5)
    expect(p.ratio).toBeCloseTo(0.8, 10)
    expect(p.unit).toBe('classes')
    // Parity: ratio < 1 ⟺ detector does not fire.
    expect(p.ratio).toBeLessThan(1)
    expect(realAggregateFires(sessions, rule.rule_config, NOW)).toBe(false)
  })

  it('5/5 → ratio 1.0 and the real detector DOES fire', () => {
    const sessions = [1, 2, 3, 4, 5].map((n) => classSession(`2026-06-0${n}T12:00:00Z`))
    const stats = memberAchievementStats(sessions, NOW)
    const p = ruleProgress(rule, stats)
    expect(p.current).toBe(5)
    expect(p.ratio).toBe(1)
    // Parity: ratio === 1 ⟺ detector fires (current >= threshold).
    expect(realAggregateFires(sessions, rule.rule_config, NOW)).toBe(true)
  })

  it('caps ratio at 1 when over target (6/5) but detector still fires', () => {
    const sessions = [1, 2, 3, 4, 5, 6].map((n) => classSession(`2026-06-0${n}T12:00:00Z`))
    const stats = memberAchievementStats(sessions, NOW)
    const p = ruleProgress(rule, stats)
    expect(p.current).toBe(6)
    expect(p.ratio).toBe(1)
    expect(realAggregateFires(sessions, rule.rule_config, NOW)).toBe(true)
  })
})

// ── aggregate_threshold with period boundary (weekly points) ─────────────────

describe('aggregate_threshold: 500 points in a WEEK (ISO-week UTC boundary)', () => {
  const rule = { rule_type: 'aggregate_threshold', rule_config: { field: 'effort_points', period: 'week', threshold: 500 } }
  // NOW = Fri 2026-07-03; ISO week starts Mon 2026-06-29 00:00 UTC.

  it('only counts sessions inside the current ISO week', () => {
    const sessions = [
      classSession('2026-06-28T23:59:00Z', { effort_points: 400 }), // Sun — PREVIOUS week, excluded
      classSession('2026-06-29T00:01:00Z', { effort_points: 300 }), // Mon — in week
      classSession('2026-07-02T10:00:00Z', { effort_points: 250 }), // Thu — in week
    ]
    const stats = memberAchievementStats(sessions, NOW)
    const p = ruleProgress(rule, stats)
    expect(p.current).toBe(550)            // 300 + 250 (400 excluded)
    expect(p.ratio).toBe(1)
    // Parity with the detector's own period windowing.
    expect(realAggregateFires(sessions, rule.rule_config, NOW)).toBe(true)
  })

  it('below target when the pre-week session is excluded', () => {
    const sessions = [
      classSession('2026-06-28T23:59:00Z', { effort_points: 400 }), // excluded
      classSession('2026-06-30T10:00:00Z', { effort_points: 100 }), // in week
    ]
    const stats = memberAchievementStats(sessions, NOW)
    const p = ruleProgress(rule, stats)
    expect(p.current).toBe(100)
    expect(p.ratio).toBeCloseTo(0.2, 10)
    expect(realAggregateFires(sessions, rule.rule_config, NOW)).toBe(false)
  })
})

// ── aggregate_threshold zone-minutes field math ──────────────────────────────

describe('aggregate_threshold: zone-minute field math matches sessionMetric', () => {
  it('z3plus_minutes sums (z3+z4+z5)/60 across sessions', () => {
    const rule = { rule_type: 'aggregate_threshold', rule_config: { field: 'z3plus_minutes', period: 'all_time', threshold: 30 } }
    const sessions = [
      classSession('2026-06-01T12:00:00Z', { zones_seconds: { 3: 300, 4: 300, 5: 300 } }), // 900s = 15 min
      classSession('2026-06-02T12:00:00Z', { zones_seconds: { 3: 600, 4: 300 } }),          // 900s = 15 min
    ]
    const stats = memberAchievementStats(sessions, NOW)
    const p = ruleProgress(rule, stats)
    expect(p.current).toBeCloseTo(30, 10)
    expect(p.ratio).toBe(1)
    expect(realAggregateFires(sessions, rule.rule_config, NOW)).toBe(true)
  })
})

// ── streak ───────────────────────────────────────────────────────────────────

describe('streak: 3-day', () => {
  const rule = { rule_type: 'streak', rule_config: { days: 3, gap_tolerance_days: 1 } }

  it('3-day live streak ending today → current 3, ratio 1, detector fires', () => {
    // today = 2026-07-03; live means most-recent within gap_tolerance (1 day).
    const sessions = [daySession('2026-07-01'), daySession('2026-07-02'), daySession('2026-07-03')]
    const stats = memberAchievementStats(sessions, NOW)
    const p = ruleProgress(rule, stats)
    expect(p.quantifiable).toBe(true)
    expect(p.current).toBe(3)
    expect(p.target).toBe(3)
    expect(p.ratio).toBe(1)
    expect(p.unit).toBe('day streak')
    expect(realStreakFires(sessions, rule.rule_config, NOW)).toBe(true)
  })

  it('2-day live streak → current 2, ratio 2/3, detector does not fire', () => {
    const sessions = [daySession('2026-07-02'), daySession('2026-07-03')]
    const stats = memberAchievementStats(sessions, NOW)
    const p = ruleProgress(rule, stats)
    expect(p.current).toBe(2)
    expect(p.ratio).toBeCloseTo(2 / 3, 10)
    expect(realStreakFires(sessions, rule.rule_config, NOW)).toBe(false)
  })

  it('stale streak (gap beyond tolerance) → current 0, detector does not fire', () => {
    // 3 consecutive days but a week ago; most-recent is 6 days before today.
    const sessions = [daySession('2026-06-25'), daySession('2026-06-26'), daySession('2026-06-27')]
    const stats = memberAchievementStats(sessions, NOW)
    const p = ruleProgress(rule, stats)
    expect(p.current).toBe(0)
    expect(p.ratio).toBe(0)
    expect(realStreakFires(sessions, rule.rule_config, NOW)).toBe(false)
  })

  it('broken run only counts the live tail (gap in the middle)', () => {
    // 07-03, 07-02 consecutive (live), then a gap, then 06-20.
    const sessions = [daySession('2026-06-20'), daySession('2026-07-02'), daySession('2026-07-03')]
    const stats = memberAchievementStats(sessions, NOW)
    const p = ruleProgress(rule, stats)
    expect(p.current).toBe(2) // only 07-02 → 07-03
    expect(realStreakFires(sessions, rule.rule_config, NOW)).toBe(false)
  })
})

// ── non-quantifiable types ───────────────────────────────────────────────────

describe('non-quantifiable rule types → { quantifiable: false }', () => {
  const stats = memberAchievementStats([daySession('2026-07-03')], NOW)
  const cases = [
    { rule_type: 'location_visit', rule_config: { location_count: 2 } },
    { rule_type: 'session_property', rule_config: { predicate: 'sustained_z5', threshold: 300 } },
    { rule_type: 'first_event', rule_config: { event: 'session' } },
    { rule_type: 'class_type_count', rule_config: { event_type_id: 'x', count: 5 } },
    { rule_type: 'something_unknown', rule_config: {} },
    { rule_type: 'aggregate_threshold', rule_config: { field: '', threshold: 0 } }, // guard → not quantifiable
    { rule_type: 'streak', rule_config: { days: 1 } }, // < 2 → not quantifiable
  ]
  for (const rule of cases) {
    it(`${rule.rule_type} (${JSON.stringify(rule.rule_config)}) is not quantifiable`, () => {
      expect(ruleProgress(rule, stats)).toEqual({ quantifiable: false })
    })
  }
})

// ── empty sessions ───────────────────────────────────────────────────────────

describe('empty sessions', () => {
  it('all ratios 0 and nothing crashes', () => {
    const stats = memberAchievementStats([], NOW)
    const agg = ruleProgress({ rule_type: 'aggregate_threshold', rule_config: { field: 'classes', period: 'all_time', threshold: 5 } }, stats)
    expect(agg).toMatchObject({ quantifiable: true, current: 0, target: 5, ratio: 0 })
    const streak = ruleProgress({ rule_type: 'streak', rule_config: { days: 3, gap_tolerance_days: 1 } }, stats)
    expect(streak).toMatchObject({ quantifiable: true, current: 0, target: 3, ratio: 0 })
  })

  it('handles null/undefined sessions arg', () => {
    const stats = memberAchievementStats(undefined, NOW)
    expect(stats.uniqDayMs).toEqual([])
    expect(stats.aggregateAllTime('classes')).toBe(0)
  })
})
