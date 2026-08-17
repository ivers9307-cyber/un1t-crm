// WAVE-9 — pure helper for the in-app "Your week" digest card (mobile Home).
//
// No IO, no React, no SecureStore — just derivation from the member's own
// heart_rate_sessions rows for the LAST COMPLETED Europe/Dublin week. The
// SecureStore "seen this ISO week" flag lives in mobile/lib/week-digest-seen.js;
// the friends-league finish is fetched separately (best-effort) and threaded in
// as `leagueFinish` so this stays IO-free and unit-testable.
//
// Week-boundary choice
// --------------------
// Weeks start Monday on the Europe/Dublin calendar — the SAME boundary the
// weekly friends league uses (shared/dublin-time.js `dublinWeekStartMs`). The
// LAST completed week is the half-open UTC-ms window
//   [ dublinWeekStartMs(now) - 7d , dublinWeekStartMs(now) )
// where the lower bound is re-derived through `dublinWeekStartMs` (NOT a raw
// `- 7*DAY` subtraction off the upper bound) so a DST week — a civil week that
// is 23h or 25h long — still lands its Monday 00:00 Dublin boundary exactly.
// A session at Sun 23:55 Dublin and one at Mon 00:05 Dublin therefore fall in
// the correct week regardless of GMT/IST.

import { dublinWeekStartMs, dublinIsoWeekKey, dublinDateKey, DUBLIN_DAY_MS } from './dublin-time.js'
import { isBurn } from './heart-rate.js'

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// 'D Mon' label (e.g. '28 Jun') for the Dublin calendar day of a UTC instant.
function dublinDayLabel(ms) {
  const [y, m, d] = dublinDateKey(ms).split('-').map(Number)
  return `${d} ${MONTHS_SHORT[m - 1]}`
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Build the last-COMPLETED-Dublin-week recap from the member's own sessions.
 * Pure + total: never throws on empty/partial input.
 *
 * @param {Array<{started_at:string, ended_at?:string|null, effort_points?:number, zones_seconds?:object}>} sessions
 *   the member's OWN heart_rate_sessions rows (a superset is fine — this filters
 *   to the last completed week and ignores un-ended sessions).
 * @param {number} nowMs  reference instant (defaults to Date.now()).
 * @param {{ leagueFinish?: {rank:number, of:number}|null }} [opts]
 *   last week's friends-league finish, if the member has friends (else null).
 * @returns {{
 *   weekKey: string,                 // Dublin ISO-week key of the recapped week, e.g. '2026-W27'
 *   weekLabel: string,               // human range, e.g. '28 Jun–4 Jul'
 *   classes: number,                 // sessions completed last week
 *   points: number,                  // total UN1T Points earned last week
 *   burnCount: number,               // sessions that earned The Burn
 *   earnedBurn: boolean,             // burnCount > 0
 *   bestSessionPoints: number,       // highest single-session points last week
 *   leagueFinish: {rank:number, of:number}|null,
 *   hasContent: boolean,             // >=1 completed session last week
 * }}
 */
export function weekDigestModel(sessions, nowMs = Date.now(), { leagueFinish = null } = {}) {
  // Last completed week window (half-open, UTC ms). Re-derive the lower bound
  // through dublinWeekStartMs so a DST week keeps an exact Monday boundary.
  const thisWeekStart = dublinWeekStartMs(nowMs)
  const lastWeekStart = dublinWeekStartMs(thisWeekStart - DUBLIN_DAY_MS) // a day inside last week
  const startMs = lastWeekStart
  const endMs = thisWeekStart

  // ISO-week key + label anchor on a day squarely inside last week (its Monday),
  // never on the exclusive upper bound.
  const weekKey = dublinIsoWeekKey(startMs)
  // Label spans Mon → Sun of last week (endMs is exclusive Monday-of-this-week,
  // so the last day is endMs - 1 day).
  const weekLabel = `${dublinDayLabel(startMs)}–${dublinDayLabel(endMs - DUBLIN_DAY_MS)}`

  let classes = 0
  let points = 0
  let burnCount = 0
  let bestSessionPoints = 0

  for (const s of sessions || []) {
    if (!s || !s.ended_at) continue // only completed sessions count
    const t = Date.parse(s.started_at)
    if (!Number.isFinite(t) || t < startMs || t >= endMs) continue
    classes += 1
    const p = num(s.effort_points)
    points += p
    if (p > bestSessionPoints) bestSessionPoints = p
    if (isBurn(s.zones_seconds)) burnCount += 1
  }

  // Normalise/validate the league finish — only surface a sane {rank, of}.
  let finish = null
  if (leagueFinish && Number.isFinite(Number(leagueFinish.rank)) && Number.isFinite(Number(leagueFinish.of))) {
    const rank = Math.trunc(Number(leagueFinish.rank))
    const of = Math.trunc(Number(leagueFinish.of))
    if (rank >= 1 && of >= 1 && rank <= of) finish = { rank, of }
  }

  return {
    weekKey,
    weekLabel,
    classes,
    points: Math.round(points),
    burnCount,
    earnedBurn: burnCount > 0,
    bestSessionPoints: Math.round(bestSessionPoints),
    leagueFinish: finish,
    hasContent: classes > 0,
  }
}
