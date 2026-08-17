// Progress-to-unlock for LOCKED, quantifiable achievements.
//
// SOURCE OF TRUTH: un1t-crm/src/lib/achievements.js — the real award
// evaluator (buildAchievementContext / detectAggregateThreshold /
// detectStreak / sessionMetric / periodStart). This module MIRRORS its
// semantics VERBATIM so the progress bar reaches 100% if and only if the
// awarding detector would fire. It is parity, NOT "better":
//
//   - Period boundaries are server-local/UTC (startOfIsoWeek = Monday
//     00:00 UTC; startOfMonth/Year = UTC calendar). We DO NOT convert to
//     Dublin time — matching what actually awards beats timezone
//     correctness (see the contract in the task brief).
//   - Streak day-keys are UTC calendar days; the streak is "live" only if
//     the most-recent training day is within gap_tolerance_days of today.
//   - sessionMetric field math (classes=1, effort_points, z*_minutes,
//     total_minutes) is copied exactly, including the seconds→minutes /60.
//
// The one intentional difference from the evaluator: the evaluator builds
// its context around a single just-ended session (`session` + `history`).
// A member browsing the achievements screen has no "current session", so
// here we aggregate over ALL of the member's ended sessions. That is the
// same set the detector sees at award time ([...history, session]) — we
// just don't distinguish the last one. Aggregate totals and streak length
// are identical; the excluded detector-only bits (priorZ5, PR-by-event,
// isFirstSession) are session-relative and belong to NON-quantifiable
// rule types, which this module reports as { quantifiable: false }.
//
// Pure + framework-free: importable by React Native (mobile) and Next (web).

const MS_PER_DAY = 24 * 3600 * 1000

// ── Period helpers (VERBATIM from un1t-crm/src/lib/achievements.js) ──────────
// ISO-week boundary: Monday 00:00:00 UTC.
function startOfIsoWeek(date) {
  const d = new Date(date)
  const day = (d.getUTCDay() + 6) % 7 // 0=Mon … 6=Sun
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - day)
  return d
}
function startOfMonth(date) {
  const d = new Date(date)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}
function startOfYear(date) {
  const d = new Date(date)
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
}
function periodStart(period, ref) {
  if (period === 'week') return startOfIsoWeek(ref)
  if (period === 'month') return startOfMonth(ref)
  if (period === 'year') return startOfYear(ref)
  return null // 'all_time'
}

// ── Field extractors (VERBATIM from un1t-crm/src/lib/achievements.js) ────────
function zonesSecondsSafe(s) {
  return s?.zones_seconds || {}
}

/** Per-session contribution for a field. MUST match sessionMetric() in the evaluator. */
export function sessionMetric(session, field) {
  const z = zonesSecondsSafe(session)
  const z1 = z[1] || z['1'] || 0
  const z2 = z[2] || z['2'] || 0
  const z3 = z[3] || z['3'] || 0
  const z4 = z[4] || z['4'] || 0
  const z5 = z[5] || z['5'] || 0
  switch (field) {
    case 'effort_points':  return Number(session?.effort_points) || 0
    case 'classes':        return 1
    case 'z3_minutes':     return z3 / 60
    case 'z4_minutes':     return z4 / 60
    case 'z5_minutes':     return z5 / 60
    case 'z3plus_minutes': return (z3 + z4 + z5) / 60
    case 'z4plus_minutes': return (z4 + z5) / 60
    case 'total_minutes':  return (z1 + z2 + z3 + z4 + z5) / 60
    default:               return 0
  }
}

// ── Member-wide stats (mirror of buildAchievementContext, no single session) ─

/**
 * Precompute the aggregates a member needs to gauge progress across ALL of
 * their ended sessions.
 *
 * @param {Array}  sessions  the member's ended heart_rate_sessions rows
 *   (each: { started_at, ended_at, effort_points, zones_seconds, location_id }).
 *   Order-insensitive.
 * @param {number} nowMs     "now" in epoch ms — anchors period windows and the
 *   streak liveness check. Defaults to Date.now(). Pass a fixed value in tests.
 * @returns { now, sessions, aggregateAllTime(field), aggregateInPeriod(field, period), uniqDayMs }
 */
export function memberAchievementStats(sessions, nowMs = Date.now()) {
  const all = Array.isArray(sessions) ? sessions : []
  const now = new Date(nowMs)

  // Streak spine: distinct UTC calendar days with ≥1 session, most-recent-first.
  // Day key derives from started_at||ended_at, exactly like the evaluator.
  const sortedDays = all
    .map((s) => {
      const d = new Date(s.started_at || s.ended_at)
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).getTime()
    })
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => b - a)
  const uniqDayMs = []
  for (const ms of sortedDays) {
    if (uniqDayMs[uniqDayMs.length - 1] !== ms) uniqDayMs.push(ms)
  }

  return {
    now,
    sessions: all,
    uniqDayMs,
    aggregateAllTime: (field) => all.reduce((a, s) => a + sessionMetric(s, field), 0),
    aggregateInPeriod: (field, period) => {
      const start = periodStart(period, now)
      if (!start) return all.reduce((a, s) => a + sessionMetric(s, field), 0)
      const startMs = start.getTime()
      return all.reduce((a, s) => {
        const t = new Date(s.started_at || s.ended_at).getTime()
        return t >= startMs ? a + sessionMetric(s, field) : a
      }, 0)
    },
  }
}

// ── Streak length (mirror of detectStreak's gap/live rules) ──────────────────
//
// Returns the member's CURRENT live streak length under detectStreak's exact
// rules, given gap_tolerance_days. Returns 0 when the streak is stale (the
// most recent training day is > gapTolerance days before today) — which is
// exactly when detectStreak refuses to unlock, so progress correctly reads 0.
function currentStreakLength(stats, gapTolerance) {
  const days = stats.uniqDayMs
  if (days.length === 0) return 0

  const d = stats.now
  const todayUtc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).getTime()
  const mostRecent = days[0]
  const daysSince = (todayUtc - mostRecent) / MS_PER_DAY
  if (daysSince > gapTolerance) return 0 // stale streak → detector wouldn't fire

  // Count the run of consecutive (exactly 1 day apart) days from most-recent.
  let streak = 1
  for (let i = 1; i < days.length; i++) {
    const gap = (days[i - 1] - days[i]) / MS_PER_DAY
    if (gap === 1) streak++
    else break
  }
  return streak
}

// ── Unit labels (human-readable, derived from the field) ─────────────────────
const FIELD_UNIT = {
  classes:        'classes',
  effort_points:  'points',
  z3_minutes:     'Zone 3 min',
  z4_minutes:     'Zone 4 min',
  z5_minutes:     'Zone 5 min',
  z3plus_minutes: 'Zone 3+ min',
  z4plus_minutes: 'Zone 4+ min',
  total_minutes:  'min',
}

/**
 * Progress of a member toward one rule.
 *
 * @param {object} rule   an achievement_rules row: { rule_type, rule_config }.
 * @param {object} stats  from memberAchievementStats().
 * @returns {{ quantifiable: boolean, current?, target?, ratio?, unit? }}
 *
 * Quantifiable rule types:
 *   - aggregate_threshold → current = same aggregate the detector sums;
 *     target = threshold; ratio = min(current/target, 1). ratio===1 iff
 *     current >= threshold (detectAggregateThreshold's exact fire condition).
 *   - streak → current = live streak length (detectStreak rules);
 *     target = days; ratio = min(current/target, 1).
 * Everything else (location_visit, session_property, first_event, class_type_count,
 * unknown) → { quantifiable: false } and renders as a plain locked row.
 */
export function ruleProgress(rule, stats) {
  const type = rule?.rule_type
  const cfg = rule?.rule_config || {}

  if (type === 'aggregate_threshold') {
    const field = String(cfg.field || '')
    const period = String(cfg.period || 'all_time')
    const target = Number(cfg.threshold) || 0
    // Mirror detectAggregateThreshold's guard: no field / non-positive
    // threshold can never fire → treat as non-quantifiable (no bar).
    if (!field || target <= 0) return { quantifiable: false }
    const current = period === 'all_time'
      ? stats.aggregateAllTime(field)
      : stats.aggregateInPeriod(field, period)
    const ratio = target > 0 ? Math.min(current / target, 1) : 0
    return {
      quantifiable: true,
      current,
      target,
      ratio,
      unit: FIELD_UNIT[field] || '',
    }
  }

  if (type === 'streak') {
    const target = Number(cfg.days) || 0
    const gapTolerance = Number(cfg.gap_tolerance_days) || 0
    // detectStreak refuses anything < 2 days → not a meaningful bar.
    if (target < 2) return { quantifiable: false }
    const current = currentStreakLength(stats, gapTolerance)
    const ratio = Math.min(current / target, 1)
    return {
      quantifiable: true,
      current,
      target,
      ratio,
      unit: 'day streak',
    }
  }

  // first_event, session_property, location_visit, class_type_count, unknown.
  return { quantifiable: false }
}
