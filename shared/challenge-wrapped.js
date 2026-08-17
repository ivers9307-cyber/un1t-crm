// FLAGSHIP.B3 — pure helper for the challenge "Wrapped" finisher story (mobile).
//
// No IO, no React, no SecureStore — just derivation from the member's OWN
// heart_rate_sessions (RLS-scoped, own data only), the challenge definition,
// and (optionally) a rank the Compete screen already loaded + the InBody
// bookend from shared/inbody.js. Mirrors shared/month-wrapped.js: unit-testable,
// reuses existing analytics, and stays own-stats-only (rank is the ONLY
// cross-member figure and it is passed in already masked by the standings RPC —
// never recomputed here).
//
// Challenge windows are Europe/Dublin CALENDAR days — the same boundaries as the
// challenge_standings RPC — so own totals here line up with the standings a
// member saw on the live board. windowIso already encodes that (end-exclusive
// 00:00 Dublin of the day after ends_on).

import { metricValue, windowIso } from './challenges.js'

// Metric → the count-up hero label + how the member's own total reads.
const METRIC_LABEL = {
  points: 'UN1T Points',
  classes: 'classes',
  z4plus_minutes: 'Zone 4+ min',
}

function startedMs(s) {
  const t = Date.parse(s?.started_at)
  return Number.isFinite(t) ? t : null
}

/**
 * Europe/Dublin day window for a challenge, in ms. End is EXCLUSIVE (00:00
 * Dublin of the day after ends_on), matching windowIso / the standings RPC.
 * Returns null when either date is missing/unparseable.
 */
export function challengeWindowMs(challenge) {
  if (!challenge?.starts_on || !challenge?.ends_on) return null
  const { fromIso, toIso } = windowIso(challenge)
  const fromMs = Date.parse(fromIso)
  const toMs = Date.parse(toIso)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null
  return { fromMs, toMs }
}

/**
 * Trigger predicate for the Compete screen: is this a FLAGSHIP challenge that
 * ENDED within the last `days` days? Falsy `is_flagship` → false (feature stays
 * inert until the CRM flag lands). Never throws.
 *
 * @param {object} challenge  { is_flagship, starts_on, ends_on }
 * @param {number} [nowMs]
 * @param {number} [days]  window after end during which the finisher is offered
 */
export function endedRecentlyFlagship(challenge, nowMs = Date.now(), days = 14) {
  if (challenge?.is_flagship !== true) return false
  // Bail on missing/unparseable dates first — challengeWindowMs is date-safe
  // (returns null) where challengePhase would throw via dublinDayStartMs.
  const win = challengeWindowMs(challenge)
  if (!win) return false
  // toMs is the end-exclusive instant (00:00 Dublin after ends_on) — i.e. the
  // moment the challenge closed. It has ended iff we're at/after that instant;
  // offer the finisher for `days` after it (and never before the close).
  const sinceMs = nowMs - days * 24 * 3600 * 1000
  return win.toMs <= nowMs && win.toMs > sinceMs
}

/**
 * Count the member's OWN attended classes + their metric total inside the
 * challenge window, from their heart_rate_sessions. `classes` = 1 per session
 * (source-agnostic, same as the RPC's COUNT(*)); metric totals reuse the shared
 * per-session metricValue so they match the live board's arithmetic.
 */
export function ownWindowStats(sessions, challenge, nowMs = Date.now()) {
  const win = challengeWindowMs(challenge)
  const out = { classes: 0, points: 0, metricTotal: 0 }
  if (!win) return out
  const metric = challenge?.metric || 'classes'
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const t = startedMs(s)
    // In-window is [fromMs, toMs) AND at/before now (a future-dated row can't
    // count). Dublin-day boundaries via windowIso keep this aligned to the RPC.
    if (t === null || t < win.fromMs || t >= win.toMs || t > nowMs) continue
    out.classes += 1
    out.points += metricValue(s, 'points')
    out.metricTotal += metricValue(s, metric)
  }
  out.points = Math.round(out.points)
  out.metricTotal = Math.round(out.metricTotal * 100) / 100
  return out
}

/**
 * Build the challenge Wrapped finisher story model — OWN stats only. Pure +
 * total: never throws on empty/partial input.
 *
 * @param {object}   args
 * @param {object}   args.challenge  { id, name, metric, starts_on, ends_on, is_flagship, ... }
 * @param {Array}    args.sessions   the member's own heart_rate_sessions rows
 * @param {number|null} [args.rank]  the member's rank from the standings the Compete screen loaded (masked); null when unknown
 * @param {number|null} [args.count] participant count for the "of N" line; null when unknown
 * @param {object|null} [args.bookend]  inbodyBookend(...) output, or null
 * @param {number}   [args.nowMs]
 * @returns {{
 *   hasContent: boolean,
 *   name: string,
 *   metric: string,
 *   metricLabel: string,
 *   classes: number,
 *   points: number,
 *   metricTotal: number,
 *   rank: number|null,
 *   count: number|null,
 *   finisher: boolean,
 *   inbody: { label: string, unit: string, delta: number, dp: number }|null,
 * }}
 */
export function challengeWrappedModel({ challenge, sessions, rank = null, count = null, bookend = null, nowMs = Date.now() } = {}) {
  const name = String(challenge?.name || 'Challenge')
  const metric = challenge?.metric || 'classes'
  const metricLabel = METRIC_LABEL[metric] || metric

  const empty = {
    hasContent: false,
    name, metric, metricLabel,
    classes: 0, points: 0, metricTotal: 0,
    rank: null, count: null, finisher: false, inbody: null,
  }
  if (!challenge?.starts_on || !challenge?.ends_on) return empty

  // A finisher recap is only valid for a FLAGSHIP challenge that has ENDED.
  // The in-app trigger (endedRecentlyFlagship) already gates the entry, but the
  // model must independently refuse a premature/ineligible recap so a direct
  // deep-link to /wrapped/challenge/<id> for a non-flagship or still-running
  // challenge can't render a false finisher story.
  const win = challengeWindowMs(challenge)
  if (challenge?.is_flagship !== true || !win || win.toMs > nowMs) return empty

  const stats = ownWindowStats(sessions, challenge, nowMs)

  // No participation in the window → nothing to celebrate (the trigger also
  // gates on this, but the model must not present an empty finisher).
  if (stats.classes <= 0) return { ...empty, hasContent: false }

  const safeRank = Number.isFinite(rank) && rank > 0 ? Math.round(rank) : null
  const safeCount = Number.isFinite(count) && count > 0 ? Math.round(count) : null

  return {
    hasContent: true,
    name, metric, metricLabel,
    classes: stats.classes,
    points: stats.points,
    metricTotal: stats.metricTotal,
    rank: safeRank,
    count: safeCount,
    // Finisher = the member showed up and completed the challenge (≥1 class in
    // window). Own-stats-only; no per-member target exists for individual
    // challenges, so "completed" is the honest, always-derivable badge.
    finisher: true,
    inbody: pickInbodyHighlight(bookend),
  }
}

// Best-effort single InBody line for the story: the most notable IMPROVED
// metric delta (prefer muscle↑, then body-fat↓, then weight). Returns null when
// there's no bookend or no improved metric. Own-data-only.
function pickInbodyHighlight(bookend) {
  if (!bookend || !Array.isArray(bookend.metrics)) return null
  const order = ['smm_kg', 'pbf_percent', 'weight_kg']
  for (const key of order) {
    const m = bookend.metrics.find((x) => x.key === key)
    if (m && m.improved === true && m.delta !== null && Math.abs(m.delta) >= 0.05) {
      return { label: m.label, unit: m.unit || '', delta: m.delta, dp: Number.isFinite(m.dp) ? m.dp : 1 }
    }
  }
  return null
}

export { METRIC_LABEL }
