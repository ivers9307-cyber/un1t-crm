// New-members cohort board — pure helpers (no IO). Powers the "New members"
// scope on the Compete → Challenges toggle: a member is ranked only against
// peers in their first `COHORT_WINDOW_DAYS` days. The DB reads + standings live
// in the data layer (load-cohort-board.js); this file is the cohort maths and
// the min-size fallback, mirroring the pure/IO split in challenges.js.

const DAY_MS = 24 * 3600 * 1000

// Cohort window (90d) is deliberately BROADER than the journey's 42d pace
// window so the peer pool isn't hollow. Min board size guards against a
// "board of 1" — below this the app shows a friendly empty state instead.
export const COHORT_WINDOW_DAYS = 90
export const MIN_COHORT_BOARD = 3

// Parse an ISO string, Date, or epoch-ms into finite epoch-ms; else null.
function toMs(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) {
    const t = value.getTime()
    return Number.isFinite(t) ? t : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const t = new Date(value).getTime()
    return Number.isFinite(t) ? t : null
  }
  return null
}

/**
 * Is this member within their first `windowDays` days?
 * - absent / unparseable joinedAt → false
 * - future joinedAt → true (treated as brand-new)
 * - window is inclusive of day `windowDays` (day 90 in, day 91 out at 90d)
 * @param {string|number|Date} joinedAt  contacts.joined_at
 * @param {number} nowMs
 * @param {number} windowDays
 * @returns {boolean}
 */
export function isNewMember(joinedAt, nowMs = Date.now(), windowDays = COHORT_WINDOW_DAYS) {
  const joinedMs = toMs(joinedAt)
  if (joinedMs == null) return false
  const ageDays = (nowMs - joinedMs) / DAY_MS
  // Future joiners have negative age → brand-new; cap at windowDays inclusive.
  return ageDays <= windowDays
}

/**
 * Contact ids eligible for the cohort board: new members who have NOT opted
 * out of the leaderboard. Opted-out members are excluded BY CONSTRUCTION so
 * they can never appear on a board downstream.
 * @param {Array<{id: string, joined_at?: *, hr_leaderboard_opt_out?: boolean}>} contacts
 * @param {number} nowMs
 * @param {number} windowDays
 * @returns {Set<string>}
 */
export function cohortContactIds(contacts, nowMs = Date.now(), windowDays = COHORT_WINDOW_DAYS) {
  const set = new Set()
  for (const c of contacts || []) {
    if (!c || c.hr_leaderboard_opt_out) continue
    if (isNewMember(c.joined_at, nowMs, windowDays)) set.add(c.id)
  }
  return set
}

/**
 * Guard a ranked board against being too small to show. Returns the rows
 * unchanged plus a `tooSmall` flag when fewer than `minSize` ranked members
 * have a score — the app renders a friendly empty state instead of a board of 1.
 * @param {Array} rankedRows
 * @param {number} minSize
 * @returns {{ rows: Array, tooSmall: boolean }}
 */
export function applyMinSize(rankedRows, minSize = MIN_COHORT_BOARD) {
  const rows = rankedRows || []
  return { rows, tooSmall: rows.length < minSize }
}
