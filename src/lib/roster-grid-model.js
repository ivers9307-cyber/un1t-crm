// src/lib/roster-grid-model.js
//
// GRID.1 — the manager's coach-by-day grid (Schedule → Week → Coaches), as
// pure data. RosterGrid.jsx lays out what this decides; every decision is
// here because jsdom cannot see layout and a component test can only say
// "this text is present".
//
// Richard, 25 Sep 2026 (scheduler Wave 2 index): the roster is HYBRID. Only
// admin work that needs a time and a person is placed. The rest of an
// employee's contract is an unplaced ADMIN BALANCE, shown to managers as hours
// (program default 4): contract − class hours − placed admin hours, employees
// only, never pay. The ROSTER LOOK decision keeps the day-column cards; this
// grid is an ADDITIONAL view.
//
// No clock, no network, no host timezone. Dates are 'YYYY-MM-DD' strings and
// all day arithmetic is Date.UTC, so a 23h or 25h day cannot move a column.

export const ROSTER_LAYOUTS = Object.freeze(['days', 'coaches'])
export const DEFAULT_ROSTER_LAYOUT = 'days'

const DAY_MS = 86400000
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const pad2 = (n) => String(n).padStart(2, '0')

// Midnight UTC of a REAL calendar date, else null (30 Feb rolls in Date.UTC,
// so a round trip that changes the digits was never a date).
function dayMs(iso) {
  const m = (typeof iso === 'string' ? iso : '').match(ISO_DAY)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return ms
}

function isoOf(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/**
 * The Monday-to-Sunday week holding `anyDayIso`, as seven 'YYYY-MM-DD'
 * strings; [] for a date the calendar does not have.
 */
export function gridWeekDays(anyDayIso) {
  const ms = dayMs(anyDayIso)
  if (ms === null) return []
  const monday = ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS
  return Array.from({ length: 7 }, (_, i) => isoOf(monday + i * DAY_MS))
}

// ── The Days | Coaches preference ───────────────────────────────────────────
// Per viewer (a studio iPad is shared), per browser. `storage` is injected so
// this stays pure and testable: the calendar passes browserStorage(), which is
// null when the browser refuses. Every access is inside try/catch: a private
// window, blocked site data or a full quota throws, and a preference must
// never be able to break the roster.

export function rosterLayoutStorageKey(viewerId) {
  return `un1t.schedule.layout.${viewerId || 'anon'}`
}

export function loadRosterLayout(storage, viewerId) {
  try {
    const value = storage ? storage.getItem(rosterLayoutStorageKey(viewerId)) : null
    return ROSTER_LAYOUTS.includes(value) ? value : DEFAULT_ROSTER_LAYOUT
  } catch {
    return DEFAULT_ROSTER_LAYOUT
  }
}

/** true when the choice was stored; false when it could not be (the choice still applies for the visit). */
export function saveRosterLayout(storage, viewerId, layout) {
  if (!storage || !ROSTER_LAYOUTS.includes(layout)) return false
  try {
    storage.setItem(rosterLayoutStorageKey(viewerId), layout)
    return true
  } catch {
    return false
  }
}
