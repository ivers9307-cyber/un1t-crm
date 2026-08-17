// BYTE-SYNC: champ-app/shared/hr-analytics.js ↔ un1t-crm/src/lib/hr-analytics.js.
// The two files are identical except the dublin-time import below
// ('./dublin-time.js' in champ-app, '@/lib/dublin-time' in un1t-crm).
// champ-app is the canonical copy — edit there first, then mirror the change.
// Both apps render these numbers to the SAME member: drift here means the CRM
// coach view and the member app disagree on totals. The twin test files are
// fully byte-identical (they import './hr-analytics.js' relatively) — port
// tests both ways too.
//
// HR analytics helpers — pure functions that turn arrays of historical
// sessions into the comparisons the post-class email leans on.
//
// Inputs are always arrays of summary rows shaped like:
//   {
//     id, started_at, ended_at, event_type_id, class_name, category,
//     effort_points, peak_hr_bpm, avg_hr_bpm, zones_seconds,
//   }
//
// No DB, no IO. The post-class email composer is responsible for
// loading the data and passing it in. Tests can hit these with
// crafted fixtures.
//
// Math choices
// ------------
// "Recent" = last 4 weeks, "prior" = the 4 weeks before that. Same
// shape as Strava / Whoop weekly snapshots — long enough to smooth
// noise, short enough to react when behaviour changes.
//
// Percentiles use simple ordinal ranking (no interpolation) — the
// member sample sizes are small (typically <50 sessions per class
// type) and percentile rounding is fine for "you were faster than
// 8 of your last 10 RIDE classes".

import { dublinDateKey, dublinDayStartMs, dublinAddDays, dublinWeekStartMs } from './dublin-time.js'

const RECENT_DAYS = 28
const PRIOR_DAYS = 56

// ── filters / windows ────────────────────────────────────────────

export function sameClassType(sessions, eventTypeId) {
  if (!eventTypeId) return []
  return (sessions || []).filter((s) => s.event_type_id === eventTypeId)
}

/** Normalised class-name key — the single source of truth for class identity
 *  + the class_categories match key. Used by the loaders, the settings API,
 *  and the grouping below so the write key and read key can never diverge. */
export function normalizeClassName(name) {
  return String(name ?? '').trim().toLowerCase()
}

/** Same class as `className`, matched by normalized name (covers bridge-tracked
 *  Glofox sessions, which have class_name but no event_type_id). */
export function sameClass(sessions, className) {
  const key = normalizeClassName(className)
  if (!key) return []
  return (sessions || []).filter((s) => normalizeClassName(s.class_name) === key)
}

/** Same category (cardio/strength/conditioning) as `category`. */
export function sameCategory(sessions, category) {
  if (!category) return []
  return (sessions || []).filter((s) => s.category === category)
}

export function withinDays(sessions, days, nowMs = Date.now()) {
  const cutoff = nowMs - days * 24 * 3600 * 1000
  return (sessions || []).filter((s) => new Date(s.started_at).getTime() >= cutoff)
}

/**
 * inWindow(sessions, fromDays, toDays) — sessions whose start
 * landed between the fromDays-old boundary and the toDays-old
 * boundary, where fromDays > toDays (older boundary first).
 * Used to slice "the 4 weeks BEFORE the last 4 weeks" = (56, 28).
 */
export function inWindow(sessions, fromDays, toDays, nowMs = Date.now()) {
  const olderMs = nowMs - fromDays * 24 * 3600 * 1000
  const newerMs = nowMs - toDays * 24 * 3600 * 1000
  return (sessions || []).filter((s) => {
    const t = new Date(s.started_at).getTime()
    return t >= olderMs && t < newerMs
  })
}

/**
 * Sort a copy of `sessions` by started_at DESCENDING (most recent first).
 * Non-mutating. Used before a "last N" slice so the slice is the N MOST RECENT.
 */
export function byStartedDesc(sessions) {
  return [...(sessions || [])].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  )
}

// ── aggregates ──────────────────────────────────────────────────

export function meanField(sessions, field) {
  const vals = (sessions || []).map((s) => Number(s[field])).filter((v) => Number.isFinite(v))
  if (vals.length === 0) return null
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

/**
 * Ordinal percentile of `value` against a sample. Returns 0..1.
 * 1 means "best (or tied for best)". Used for messages like
 * "you were in the top 20% of your last 10 RIDE sessions".
 */
export function percentileOf(value, sample, field) {
  if (!Number.isFinite(value)) return null
  const others = (sample || [])
    .map((s) => Number(s[field]))
    .filter((v) => Number.isFinite(v))
  if (others.length === 0) return null
  // Count how many others are STRICTLY less than this value, plus
  // half of ties — the standard "midrank" definition. Good for
  // small samples.
  const lt = others.filter((v) => v < value).length
  const eq = others.filter((v) => v === value).length
  return (lt + eq / 2) / others.length
}

// ── trend ───────────────────────────────────────────────────────

/**
 * "How am I trending vs the last cycle" snapshot for a single
 * field (effort_points, peak_hr_bpm, etc).
 *
 * Returns { recentMean, priorMean, deltaPct, direction, hasEnoughData }.
 * - hasEnoughData: false if either window has fewer than 2 samples
 * - direction: 'up' | 'flat' | 'down' (flat if |deltaPct| < 0.05)
 */
export function trendDelta(allSessions, field, nowMs = Date.now()) {
  const recent = withinDays(allSessions, RECENT_DAYS, nowMs)
  const prior = inWindow(allSessions, PRIOR_DAYS, RECENT_DAYS, nowMs)
  const hasEnoughData = recent.length >= 2 && prior.length >= 2
  const recentMean = meanField(recent, field)
  const priorMean = meanField(prior, field)
  let deltaPct = null
  let direction = 'flat'
  if (hasEnoughData && recentMean != null && priorMean != null && priorMean !== 0) {
    deltaPct = (recentMean - priorMean) / priorMean
    if (deltaPct > 0.05) direction = 'up'
    else if (deltaPct < -0.05) direction = 'down'
  }
  return { hasEnoughData, recentMean, priorMean, deltaPct, direction, recentCount: recent.length, priorCount: prior.length }
}

// ── highlight picker ────────────────────────────────────────────
//
// Picks ONE primary "highlight" line for the email — the most
// brag-worthy thing about this session. Order matters: we check
// from rarest+most-impressive down. First match wins.

const HIGHLIGHT_RULES = [
  // First-ever session at this gym.
  {
    id: 'first_ever',
    test: ({ historyExclThis }) => historyExclThis.length === 0,
    msg: () => 'Your first heart-rate session — welcome to the data.',
  },
  // First time hitting Z5 for any duration.
  {
    id: 'first_z5',
    test: ({ thisSession, historyExclThis }) => {
      const z5Sec = Number(thisSession.zones_seconds?.[5] ?? thisSession.zones_seconds?.['5'] ?? 0)
      if (z5Sec < 30) return false
      return !historyExclThis.some((s) => Number(s.zones_seconds?.[5] ?? s.zones_seconds?.['5'] ?? 0) >= 30)
    },
    msg: ({ thisSession }) => {
      const z5min = Math.round(Number(thisSession.zones_seconds?.[5] ?? thisSession.zones_seconds?.['5'] ?? 0) / 60)
      return `First time in red zone — you held Zone 5 for ${z5min} min.`
    },
  },
  // New peak HR (highest ever).
  {
    id: 'new_peak',
    test: ({ thisSession, historyExclThis }) => {
      const peak = Number(thisSession.peak_hr_bpm)
      if (!Number.isFinite(peak)) return false
      const prior = historyExclThis.map((s) => Number(s.peak_hr_bpm)).filter(Number.isFinite)
      return prior.length >= 1 && peak > Math.max(...prior)
    },
    msg: ({ thisSession }) => `New peak heart rate: ${thisSession.peak_hr_bpm} bpm.`,
  },
  // Highest UN1T Points ever for this class type.
  {
    id: 'best_class_type_points',
    test: ({ thisSession, sameTypeExclThis }) => {
      const pts = Number(thisSession.effort_points)
      if (!Number.isFinite(pts) || pts <= 0) return false
      if (sameTypeExclThis.length < 2) return false
      const prior = sameTypeExclThis.map((s) => Number(s.effort_points)).filter(Number.isFinite)
      return prior.length >= 2 && pts > Math.max(...prior)
    },
    msg: ({ thisSession, eventTypeName }) =>
      `Personal best for ${eventTypeName || 'this class'} — ${thisSession.effort_points} UN1T Points.`,
  },
  // Top-quartile points across the last 30 days (any class).
  {
    id: 'top_quartile_recent',
    test: ({ thisSession, recentSessionsExclThis }) => {
      if (recentSessionsExclThis.length < 4) return false
      const pct = percentileOf(Number(thisSession.effort_points), recentSessionsExclThis, 'effort_points')
      return pct != null && pct >= 0.75
    },
    msg: ({ thisSession, recentSessionsExclThis }) => {
      const pct = percentileOf(Number(thisSession.effort_points), recentSessionsExclThis, 'effort_points')
      const pctRound = Math.round(pct * 100)
      // Clamp to 1: a best-ever session has percentile 1 → 100-100 = 0,
      // which would read "top 0%" (nonsense). "Top 1%" is the floor.
      const topPct = Math.max(1, 100 - pctRound)
      return `In the top ${topPct}% of your last 4 weeks — ${thisSession.effort_points} UN1T Points.`
    },
  },
  // Streak — Nth class in N days.
  {
    id: 'streak',
    test: ({ thisSession, historyExclThis }) => {
      const streak = computeStreak(thisSession, historyExclThis)
      return streak >= 3
    },
    msg: ({ thisSession, historyExclThis }) => {
      const streak = computeStreak(thisSession, historyExclThis)
      return `${streak}-day streak — keep it rolling.`
    },
  },
]

export function pickHighlight({ thisSession, history, eventTypeName, nowMs = Date.now() }) {
  if (!thisSession) return null
  const historyExclThis = (history || []).filter((s) => s.id !== thisSession.id)
  const sameTypeExclThis = sameClass(historyExclThis, thisSession.class_name)
  // Pass nowMs through so the recent-window check matches the rest of
  // this file (withinDays / inWindow / trendDelta all accept it).
  // Without this the percentile-vs-last-28d highlight is non-
  // deterministic against fixture data and stale CI runs flake when
  // the test's anchor date drifts more than 28d behind today.
  const recentSessionsExclThis = withinDays(historyExclThis, RECENT_DAYS, nowMs)

  const ctx = { thisSession, historyExclThis, sameTypeExclThis, recentSessionsExclThis, eventTypeName }
  for (const rule of HIGHLIGHT_RULES) {
    if (rule.test(ctx)) return { id: rule.id, message: rule.msg(ctx) }
  }
  return null
}

// ── helpers ──────────────────────────────────────────────────────

/**
 * Counts consecutive days ending on `thisSession`'s day on which the
 * member trained. `thisSession` counts as its own day; we walk back one
 * Europe/Dublin calendar day at a time while history covers it.
 *
 * Day-buckets are Europe/Dublin calendar days (via dublinDateKey), the
 * same boundary `currentStreak` uses — so the email `streak` highlight
 * and the in-app live streak agree near midnight during IST/BST.
 */
function computeStreak(thisSession, history) {
  const days = new Set([dublinDateKey(thisSession.started_at)])
  for (const s of history) days.add(dublinDateKey(s.started_at))

  let streak = 0
  // Walk back one Europe/Dublin calendar day per step. dublinAddDays
  // steps via a Dublin-noon anchor so it never drifts across a DST edge.
  let cursorKey = dublinDateKey(thisSession.started_at)
  while (days.has(cursorKey)) {
    streak++
    cursorKey = dublinAddDays(cursorKey, -1)
  }
  return streak
}

/**
 * Live consecutive-day training streak as of `nowMs`.
 *
 * `current` = the run of consecutive Europe/Dublin calendar days ending
 * today OR yesterday
 * (one-day gap tolerance, so a member who hasn't trained YET today still
 * sees yesterday's streak). 0 if the most recent session is older than
 * yesterday. `best` = the longest consecutive-day run anywhere in the input.
 * `best` is 0 when there are no sessions and 1 for a single session.
 *
 * Distinct from the private `computeStreak(thisSession, history)` above:
 * this takes a plain sessions array and is anchored on `nowMs`, not on a
 * "this session" row.
 *
 * @param {Array<{started_at?:string, ended_at?:string}>} sessions
 * @param {number} nowMs
 * @returns {{current:number, best:number, lastDayMs:number|null}}
 */
export function currentStreak(sessions, nowMs = Date.now()) {
  // Bucket each session into its Europe/Dublin calendar day.
  const days = new Set()
  for (const s of sessions || []) {
    const iso = s && (s.started_at || s.ended_at)
    if (iso) days.add(dublinDateKey(iso))
  }
  if (days.size === 0) return { current: 0, best: 0, lastDayMs: null }

  // Sort descending: 'YYYY-MM-DD' strings sort lexicographically.
  const sorted = [...days].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  // lastDayMs = UTC-ms of Dublin midnight for the most recent day, the
  // same anchor streakAtRisk compares against (Dublin day boundaries).
  const lastDayMs = dublinDayStartMs(sorted[0])

  const todayKey = dublinDateKey(nowMs)
  const yesterdayKey = dublinAddDays(todayKey, -1)

  let current = 0
  if (sorted[0] === todayKey || sorted[0] === yesterdayKey) {
    current = 1
    let cursor = sorted[0]
    for (let i = 1; i < sorted.length; i++) {
      // The previous Europe/Dublin calendar day.
      const prevKey = dublinAddDays(cursor, -1)
      if (sorted[i] === prevKey) { current++; cursor = sorted[i] } else break
    }
  }

  let best = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    const prevKey = dublinAddDays(sorted[i - 1], -1)
    if (sorted[i] === prevKey) { run++; if (run > best) best = run } else { run = 1 }
  }
  if (current > best) best = current

  return { current, best, lastDayMs }
}

/**
 * Weeks-based training streak — the count of consecutive Europe/Dublin ISO
 * weeks (Mon-anchored) in which the member trained at least `minPerWeek`
 * sessions, ending on the CURRENT week or the LAST completed week (one-week
 * grace so a member who hasn't trained yet THIS week still sees last week's
 * streak). This is the streak the Home hero leads with — it rewards a weekly
 * training habit rather than day-perfect consistency.
 *
 * Distinct from `currentStreak` (consecutive days). Returns 0 when the most
 * recent qualifying week is older than last week.
 *
 * @param {Array<{started_at?:string, ended_at?:string}>} sessions
 * @param {object} [opts]
 * @param {number} [opts.minPerWeek=1]  sessions needed for a week to "count"
 * @param {number} [opts.nowMs=Date.now()]
 * @returns {{current:number, best:number, thisWeekCount:number, minPerWeek:number}}
 */
export function weeklyStreak(sessions, { minPerWeek = 1, nowMs = Date.now() } = {}) {
  const min = Math.max(1, Number(minPerWeek) || 1)

  // Count sessions per Dublin ISO-week-start (UTC ms of that Monday 00:00).
  const perWeek = new Map()
  for (const s of sessions || []) {
    const iso = s && (s.started_at || s.ended_at)
    if (!iso) continue
    const wk = dublinWeekStartMs(iso)
    perWeek.set(wk, (perWeek.get(wk) || 0) + 1)
  }

  const thisWeekMs = dublinWeekStartMs(nowMs)
  // Previous week's Monday: step back 7 days from mid-week to dodge any DST edge.
  const prevWeekMs = (ms) => dublinWeekStartMs(ms - 3.5 * 24 * 3600 * 1000)
  const thisWeekCount = perWeek.get(thisWeekMs) || 0

  if (perWeek.size === 0) return { current: 0, best: 0, thisWeekCount: 0, minPerWeek: min }

  const qualifies = (ms) => (perWeek.get(ms) || 0) >= min

  // current: walk back from this week (or last week if this week hasn't
  // qualified yet) while each week qualifies.
  let current = 0
  let anchor = qualifies(thisWeekMs) ? thisWeekMs : prevWeekMs(thisWeekMs)
  while (qualifies(anchor)) {
    current++
    anchor = prevWeekMs(anchor)
  }

  // best: longest run of consecutive qualifying weeks anywhere in the data.
  const qualifyingWeeks = [...perWeek.entries()]
    .filter(([, c]) => c >= min)
    .map(([ms]) => ms)
    .sort((a, b) => a - b)
  let best = 0
  let run = 0
  let prev = null
  for (const ms of qualifyingWeeks) {
    if (prev != null && prevWeekMs(ms) === prev) run++
    else run = 1
    if (run > best) best = run
    prev = ms
  }
  if (current > best) best = current

  return { current, best, thisWeekCount, minPerWeek: min }
}

// ── public summary builder ──────────────────────────────────────

/**
 * Roll up everything the email composer needs in one pass over
 * the data. The composer doesn't need to know about windows / fields.
 */
export function buildSessionAnalytics({ thisSession, history, eventTypeName, nowMs = Date.now() }) {
  const historyExclThis = (history || []).filter((s) => s.id !== thisSession.id)
  const sameType = sameClass(historyExclThis, thisSession.class_name)
  // The "last 8" MUST be the 8 most RECENT qualifying sessions. The loader
  // returns rows in no guaranteed order, so a bare .slice(0, 8) took an
  // arbitrary 8 whenever a member had >8 in-window sessions of a class/category,
  // making the mean/percentile non-deterministic. Sort started_at DESC first.
  const sameTypeRecent = byStartedDesc(withinDays(sameType, RECENT_DAYS, nowMs)).slice(0, 8)

  const overallPointsTrend = trendDelta(historyExclThis, 'effort_points', nowMs)
  const overallPeakTrend = trendDelta(historyExclThis, 'peak_hr_bpm', nowMs)
  const classTypeMean = meanField(sameTypeRecent, 'effort_points')
  const classTypePercentile = percentileOf(Number(thisSession.effort_points), sameTypeRecent, 'effort_points')

  // vs_category — identical maths over same-CATEGORY history (cardio/strength/…).
  // Null when this session's class is unmapped.
  const category = thisSession.category || null
  const sameCat = sameCategory(historyExclThis, category)
  const sameCatRecent = byStartedDesc(withinDays(sameCat, RECENT_DAYS, nowMs)).slice(0, 8)
  const categoryMean = meanField(sameCatRecent, 'effort_points')
  const categoryPercentile = percentileOf(Number(thisSession.effort_points), sameCatRecent, 'effort_points')

  const highlight = pickHighlight({ thisSession, history: historyExclThis, eventTypeName, nowMs })

  return {
    highlight,
    classType: {
      eventTypeId: thisSession.event_type_id,
      eventTypeName,
      recentCount: sameTypeRecent.length,
      meanPoints: classTypeMean != null ? Math.round(classTypeMean) : null,
      thisPoints: Number.isFinite(thisSession.effort_points) ? thisSession.effort_points : null,
      percentile: classTypePercentile,
    },
    category: category ? {
      categoryName: category,
      recentCount: sameCatRecent.length,
      meanPoints: categoryMean != null ? Math.round(categoryMean) : null,
      percentile: categoryPercentile,
    } : null,
    overall: {
      pointsTrend: overallPointsTrend,
      peakTrend: overallPeakTrend,
    },
  }
}
