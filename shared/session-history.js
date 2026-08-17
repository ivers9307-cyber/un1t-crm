// session-history.js — pure helpers for the "history depth" surfaces:
//   • groupSessionsByMonth — turns the flat sessions-list items (from
//     buildSessionsList) into SectionList sections, one per Europe/Dublin
//     calendar month, each carrying a per-month stat line.
//   • lifetimeMilestones — derivable all-time milestones from the member's
//     heart_rate_sessions (total sessions / points / hours / longest streak),
//     with a "notable" flag when a total has just crossed a round number.
//
// No IO. champ-app-only, like progress-analytics.js. Months are Europe/Dublin
// calendar months (see dublin-time.js) — NOT UTC — so a session near midnight
// lands in the same month the member would say it did.

import { dublinMonthKey } from './dublin-time.js'
import { currentStreak } from './hr-analytics.js'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// Human month header from a 'YYYY-MM' key, e.g. '2026-06' → 'June 2026'.
function monthTitle(key) {
  const [y, m] = key.split('-').map(Number)
  const name = MONTH_NAMES[m - 1] || key
  return `${name} ${y}`
}

const pointsOf = (s) => (Number.isFinite(s?.effort_points) ? s.effort_points : 0)
const startedMs = (s) => {
  const t = Date.parse(s?.started_at)
  return Number.isFinite(t) ? t : null
}

/**
 * Group merged history items into per-month SectionList sections.
 *
 * Input is the array from buildSessionsList (items shaped
 * { kind, key, sortMs, session?, activity? }). Sections are newest month
 * first; within a section items keep the input order (already newest-first).
 *
 * Only UN1T `heart_rate_sessions` (kind 'session') contribute to the per-month
 * points/sessions stat line — Strava rows are display-only (no UN1T points), so
 * they render inside the month they occurred but are NOT counted in the header
 * stat (mirrors the sessions-list contract).
 *
 * The month key uses the item's own timestamp (sortMs) via the Europe/Dublin
 * calendar. Items with no usable timestamp collect into a trailing 'Undated'
 * section so nothing is dropped.
 *
 * @param {Array<{kind:string,key:string,sortMs:number|null,session?:object,activity?:object}>} items
 * @returns {Array<{ key:string, title:string, monthKey:string|null,
 *   sessionCount:number, points:number, data:Array }>}
 */
export function groupSessionsByMonth(items = []) {
  const byMonth = new Map()
  const undated = []

  for (const item of items || []) {
    const ms = Number.isFinite(item?.sortMs) ? item.sortMs : null
    if (ms == null) {
      undated.push(item)
      continue
    }
    const monthKey = dublinMonthKey(ms)
    let section = byMonth.get(monthKey)
    if (!section) {
      section = { monthKey, sessionCount: 0, points: 0, data: [] }
      byMonth.set(monthKey, section)
    }
    section.data.push(item)
    // Only points-bearing UN1T sessions count toward the header stat line.
    if (item.kind === 'session') {
      section.sessionCount++
      section.points += pointsOf(item.session)
    }
  }

  // Newest month first — 'YYYY-MM' sorts lexicographically.
  const sections = [...byMonth.values()]
    .sort((a, b) => (a.monthKey < b.monthKey ? 1 : a.monthKey > b.monthKey ? -1 : 0))
    .map((s) => ({
      key: s.monthKey,
      title: monthTitle(s.monthKey),
      monthKey: s.monthKey,
      sessionCount: s.sessionCount,
      points: Math.round(s.points),
      data: s.data,
    }))

  if (undated.length > 0) {
    sections.push({
      key: 'undated',
      title: 'Undated',
      monthKey: null,
      sessionCount: undated.filter((i) => i.kind === 'session').length,
      points: 0,
      data: undated,
    })
  }

  return sections
}

// Round-number thresholds a total can "cross" — the biggest one at-or-below the
// value is the milestone we celebrate. Ascending.
const SESSION_THRESHOLDS = [10, 25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000]
const POINT_THRESHOLDS = [1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000]
const HOUR_THRESHOLDS = [10, 25, 50, 100, 150, 200, 250, 500, 750, 1000]

// Largest threshold <= value, or null if value is below the first one.
function crossed(value, thresholds) {
  let hit = null
  for (const t of thresholds) {
    if (value >= t) hit = t
    else break
  }
  return hit
}

/**
 * All-time, derivable milestones from the member's UN1T sessions.
 *
 * Only counts `heart_rate_sessions` (the points + community store) — pass the
 * raw sessions array, NOT the merged history items. Returns raw lifetime totals
 * plus a `milestones` array of the notable ones (each total that has crossed a
 * round-number threshold), so the UI can celebrate "You've trained 100 times"
 * without re-deriving anything.
 *
 * @param {Array<{started_at?:string, ended_at?:string, effort_points?:number}>} sessions
 * @param {number} nowMs
 * @returns {{
 *   totalSessions:number, totalPoints:number, totalMinutes:number,
 *   totalHours:number, longestStreak:number,
 *   milestones:Array<{ id:string, kind:string, value:number, threshold:number, label:string }>
 * }}
 */
export function lifetimeMilestones(sessions, nowMs = Date.now()) {
  const list = (sessions || []).filter((s) => startedMs(s) !== null)
  let totalPoints = 0
  let totalMinutes = 0
  for (const s of list) {
    totalPoints += pointsOf(s)
    const a = Date.parse(s?.started_at)
    const b = Date.parse(s?.ended_at)
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      totalMinutes += (b - a) / 60000
    }
  }
  const totalSessions = list.length
  totalPoints = Math.round(totalPoints)
  totalMinutes = Math.round(totalMinutes)
  const totalHours = Math.floor(totalMinutes / 60)
  const longestStreak = currentStreak(list, nowMs).best

  const milestones = []

  const sessionMs = crossed(totalSessions, SESSION_THRESHOLDS)
  if (sessionMs != null) {
    milestones.push({
      id: 'sessions',
      kind: 'sessions',
      value: totalSessions,
      threshold: sessionMs,
      label: `You've trained ${sessionMs.toLocaleString()} times at UN1T`,
    })
  }

  const pointMs = crossed(totalPoints, POINT_THRESHOLDS)
  if (pointMs != null) {
    milestones.push({
      id: 'points',
      kind: 'points',
      value: totalPoints,
      threshold: pointMs,
      label: `${pointMs.toLocaleString()} UN1T Points earned`,
    })
  }

  const hourMs = crossed(totalHours, HOUR_THRESHOLDS)
  if (hourMs != null) {
    milestones.push({
      id: 'hours',
      kind: 'hours',
      value: totalHours,
      threshold: hourMs,
      label: `${hourMs.toLocaleString()} hours of training`,
    })
  }

  if (longestStreak >= 5) {
    milestones.push({
      id: 'streak',
      kind: 'streak',
      value: longestStreak,
      threshold: longestStreak,
      label: `${longestStreak}-day best streak`,
    })
  }

  return { totalSessions, totalPoints, totalMinutes, totalHours, longestStreak, milestones }
}
