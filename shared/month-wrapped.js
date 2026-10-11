// WAVE-5 — pure helper for the "Monthly Wrapped" month-end recap story (mobile).
//
// No IO, no React, no SecureStore — just derivation from the SAME
// `monthlyRecap` + `personalRecords` outputs the Progress screen already
// computes, so it's unit-testable and reuses the existing analytics. The
// SecureStore "seen month recap" flag lives in mobile/lib/recap-seen.js.
//
// Month-boundary choice
// ---------------------
// "Which month just ended" is resolved on the MEMBER's calendar — `zone`, their
// home studio's (TZ.13, D7; omitted = Europe/Dublin) — NOT UTC. We take the
// local month of `nowMs`, step back one month, and match THAT year+month
// against the recap's months array. `monthlyRecap` itself buckets sessions in
// UTC months; the only sessions that land in a different bucket are those in
// the 00:00–01:00 Dublin window on the 1st during IST (a negligible edge for
// a whole-month total), and picking the completed month on the Dublin calendar
// keeps the label + auto-present timing consistent with streaks/goals/tiers.

import { monthKeyIn, DEFAULT_TZ } from './zoned-time.js'

// Full month names (the recap story spells them out — no abbreviations).
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

// Calendar year+month (0-based month) in `zone` for a UTC ms instant. TZ.13:
// through zoned-time's lazily-built formatters — this module used to build a
// Dublin formatter at import time, which Hermes evaluates on app start.
function localYearMonth(ms, zone) {
  const [y, m] = monthKeyIn(ms, zone).split('-').map(Number)
  return { year: y, month: m - 1 } // month → 0-based to match monthlyRecap
}

// Step one calendar month back from a { year, month(0-based) } pair.
function prevMonth({ year, month }) {
  return month === 0
    ? { year: year - 1, month: 11 }
    : { year, month: month - 1 }
}

/**
 * The 'YYYY-MM' key of the last COMPLETED local month (in `zone`) — the month a recap at
 * `nowMs` would cover. Derivable from the clock ALONE (no session data), so
 * callers can consult the "seen this month's recap" flag BEFORE fetching
 * anything. Always matches `monthWrappedModel(...).monthKey` for the same
 * `nowMs` (the model computes its key through this helper).
 *
 * @param {number} [nowMs]
 * @returns {string} e.g. '2026-06'
 */
export function monthWrappedKey(nowMs = Date.now(), zone = DEFAULT_TZ) {
  const target = prevMonth(localYearMonth(nowMs, zone))
  return `${target.year}-${String(target.month + 1).padStart(2, '0')}`
}

/**
 * Build the last-COMPLETED-month recap story from the outputs the Progress
 * screen already has. Pure + total: never throws on empty/partial input.
 *
 * @param {{months: Array, fittest: object|null}} recap  monthlyRecap(...) output
 * @param {object} records  personalRecords(...) output (best-effort PR line)
 * @param {number} [nowMs]
 * @returns {{
 *   hasContent: boolean,
 *   monthKey: string,            // 'YYYY-MM' of the recapped month (local)
 *   label: string,               // e.g. 'June 2026'
 *   monthName: string,           // e.g. 'June'
 *   year: number,
 *   points: number,
 *   sessions: number,
 *   minutes: number,
 *   avgPeakHr: number|null,
 *   isFittest: boolean,
 *   pr: { kind: string, label: string, value: number, unit: string }|null,
 * }}
 */
export function monthWrappedModel(recap, records, nowMs = Date.now(), zone = DEFAULT_TZ) {
  const target = prevMonth(localYearMonth(nowMs, zone)) // the month that just ended
  const monthKey = monthWrappedKey(nowMs, zone)
  const monthName = MONTHS[target.month] || ''
  const label = `${monthName} ${target.year}`

  const empty = {
    hasContent: false,
    monthKey, label, monthName, year: target.year,
    points: 0, sessions: 0, minutes: 0, avgPeakHr: null,
    isFittest: false, pr: null,
  }

  const monthsArr = Array.isArray(recap?.months) ? recap.months : []
  const m = monthsArr.find((x) => x && x.year === target.year && x.month === target.month)

  // No data at all for that month → don't present an empty recap.
  if (!m || !((m.count || 0) > 0)) return empty

  const fittest = recap?.fittest
  const isFittest = !!(fittest && fittest.year === target.year && fittest.month === target.month)

  return {
    hasContent: true,
    monthKey, label, monthName, year: target.year,
    points: Math.round(m.points || 0),
    sessions: m.count || 0,
    minutes: Math.round(m.minutes || 0),
    avgPeakHr: Number.isFinite(m.avgPeakHr) ? m.avgPeakHr : null,
    isFittest,
    pr: pickMonthPr(records, target, zone),
  }
}

// Best-effort: surface a personal record IF it was set during the recapped
// local month. personalRecords records carry `atMs` (session PRs) or
// `weekStartMs` (best-week); streak has no timestamp so it's excluded here.
// Returns { kind, label, value, unit } or null.
function pickMonthPr(records, target, zone) {
  const r = records || {}
  const inTargetMonth = (ms) => {
    if (!Number.isFinite(ms)) return false
    const ym = localYearMonth(ms, zone)
    return ym.year === target.year && ym.month === target.month
  }

  // Priority: best session points → highest peak HR → longest session.
  // (Best-week can straddle a month boundary, so we keep it out of the
  // per-month brag to avoid a misleading "PR this month".)
  const candidates = [
    { rec: r.bestSessionPoints, kind: 'points', label: 'New best session', unit: 'pts' },
    { rec: r.highestPeakHr, kind: 'peak', label: 'Highest peak HR ever', unit: 'bpm' },
    { rec: r.longestSessionMin, kind: 'longest', label: 'Longest session ever', unit: 'min' },
  ]
  for (const c of candidates) {
    if (c.rec && Number.isFinite(c.rec.value) && inTargetMonth(c.rec.atMs)) {
      return { kind: c.kind, label: c.label, value: c.rec.value, unit: c.unit }
    }
  }
  return null
}
