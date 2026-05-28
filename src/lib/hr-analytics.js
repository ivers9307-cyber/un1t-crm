// HR analytics helpers — pure functions that turn arrays of historical
// sessions into the comparisons the post-class email leans on.
//
// Inputs are always arrays of summary rows shaped like:
//   {
//     id, started_at, ended_at, event_type_id,
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

const RECENT_DAYS = 28
const PRIOR_DAYS = 56

// ── filters / windows ────────────────────────────────────────────

export function sameClassType(sessions, eventTypeId) {
  if (!eventTypeId) return []
  return (sessions || []).filter((s) => s.event_type_id === eventTypeId)
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
      return `First time in red zone — you held Z5 for ${z5min} min.`
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
      return `In the top ${100 - pctRound}% of your last 4 weeks — ${thisSession.effort_points} UN1T Points.`
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
  const sameTypeExclThis = sameClassType(historyExclThis, thisSession.event_type_id)
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
 * Counts consecutive days ending today on which the member trained.
 * `thisSession` counts as today; we walk back through history
 * (sorted desc by started_at) accepting one calendar day at a time.
 */
function computeStreak(thisSession, history) {
  const dayKey = (iso) => new Date(iso).toISOString().slice(0, 10)
  const days = new Set([dayKey(thisSession.started_at)])
  for (const s of history) days.add(dayKey(s.started_at))

  let streak = 0
  let cursor = new Date(thisSession.started_at)
  cursor.setUTCHours(0, 0, 0, 0)
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak++
    cursor = new Date(cursor.getTime() - 24 * 3600 * 1000)
  }
  return streak
}

// ── public summary builder ──────────────────────────────────────

/**
 * Roll up everything the email composer needs in one pass over
 * the data. The composer doesn't need to know about windows / fields.
 */
export function buildSessionAnalytics({ thisSession, history, eventTypeName, nowMs = Date.now() }) {
  const historyExclThis = (history || []).filter((s) => s.id !== thisSession.id)
  const sameType = sameClassType(historyExclThis, thisSession.event_type_id)
  const sameTypeRecent = withinDays(sameType, RECENT_DAYS, nowMs).slice(0, 8)

  const overallPointsTrend = trendDelta(historyExclThis, 'effort_points', nowMs)
  const overallPeakTrend = trendDelta(historyExclThis, 'peak_hr_bpm', nowMs)
  const classTypeMean = meanField(sameTypeRecent, 'effort_points')
  const classTypePercentile = percentileOf(Number(thisSession.effort_points), sameTypeRecent, 'effort_points')
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
    overall: {
      pointsTrend: overallPointsTrend,
      peakTrend: overallPeakTrend,
    },
  }
}
