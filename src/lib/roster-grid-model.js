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

import { workingWindow, hoursMinutesLabel, EMPLOYEE_TYPE } from '@shared/working-time'
import { formatTimeRange12h } from './schedule-overlap'

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

// ── The grid ────────────────────────────────────────────────────────────────

export const GRID_COPY = Object.freeze({
  crossStudioUnchecked: 'The other studios could not be read, so week totals, balances and working-time flags count this studio only.',
  leaveMissing: 'Leave could not be loaded, so nobody is shown on leave.',
  availabilityMissing: 'Availability could not be loaded, so nobody is shown as unavailable.',
  noRows: 'Nobody is on this studio’s team this week.',
  legend: 'Hours only. Week = every studio in this organisation. Admin balance = contract − class − placed admin, for employees with contracted hours.',
})

export function untimedLabel(n) {
  const k = Math.max(0, Math.round(Number(n) || 0))
  return `${k} shift${k === 1 ? '' : 's'} without times, not counted`
}

const byStart = (a, b) => String(a.start ?? '99:99').localeCompare(String(b.start ?? '99:99'))
  || String(a.key).localeCompare(String(b.key))

// One shift as a chip or a marker. Minutes are REAL elapsed time from
// workingWindow (override → block → template, Dublin wall clock → instants),
// the same measure as the 48-hour rule; null = no usable times (shown, not
// counted). `flags` comes from the overlays (Task 4).
function chipOf(s, flags) {
  const w = workingWindow(s)
  return {
    key: String(s.assignment_id || `${s.block_id}|${s.profile_id}`),
    block_id: s.block_id ?? null,
    date: s.block_date,
    here: s.here === true,
    location_name: s.location_name || null,
    name: s.name || 'Shift',
    kind: s.kind === 'admin' ? 'admin' : 'class',
    start: w ? w.start : null,
    time: w ? formatTimeRange12h(w.start, w.end) : 'No times',
    minutes: w ? Math.round((w.endMs - w.startMs) / 60000) : null,
    onLeave: flags.onLeave,
    unavailable: Boolean(w && !flags.onLeave && flags.unavailableDuring(w.start, w.end)),
  }
}

/**
 * The grid for one week.
 *
 * @param {object} args
 * @param {string} args.weekStart  any day of the week (snapped to its Monday)
 * @param {{ members: Array, shifts: Array, cross_studio_checked?: boolean }} args.grid
 *        GET /api/schedule/grid's `data`
 * @param {Array} [args.timeOff]       the calendar's approved-leave slice
 * @param {Array} [args.availability]  the calendar's availability slice (AVAIL.1)
 * @returns {{ days: string[], rows: Array, checked: boolean, untimed: number }}
 */
export function buildRosterGrid({ weekStart, grid, timeOff = [], availability = [] } = {}) {
  const days = gridWeekDays(weekStart)
  if (days.length !== 7 || !grid || !Array.isArray(grid.members) || !Array.isArray(grid.shifts)) {
    return { days, rows: [], checked: false, untimed: 0 }
  }
  const week = new Set(days)
  // The server already drops cancelled rows; the same rule again here so a
  // stale or hand-made payload can never count one. The window days (Sunday
  // before, Monday after) stay in `live` for the rest-gap rule only.
  const live = grid.shifts.filter((s) => s?.profile_id && s.status !== 'cancelled')
  const byPerson = new Map()
  for (const s of live) {
    if (!week.has(s.block_date)) continue
    if (!byPerson.has(s.profile_id)) byPerson.set(s.profile_id, [])
    byPerson.get(s.profile_id).push(s)
  }
  const overlays = overlaysFor(days, timeOff, availability)
  const advice = advisoriesFor(days, grid.members, live)

  const rows = grid.members.filter((m) => m?.profile_id).map((m) => {
    const mine = byPerson.get(m.profile_id) || []
    const totals = { minutes: 0, here_minutes: 0, elsewhere_minutes: 0, class_minutes: 0, admin_minutes: 0, untimed: 0 }
    let leaveDays = 0
    const cells = days.map((date) => {
      const leave = overlays.leaveOn(m.profile_id, date)
      if (leave) leaveDays += 1
      const chips = mine
        .filter((s) => s.block_date === date)
        .map((s) => chipOf(s, {
          onLeave: Boolean(leave),
          unavailableDuring: (start, end) => overlays.unavailableDuring(m.profile_id, date, start, end),
        }))
        .sort(byStart)
      for (const c of chips) {
        if (c.minutes === null) { totals.untimed += 1; continue }
        totals.minutes += c.minutes
        if (c.here) totals.here_minutes += c.minutes
        else totals.elsewhere_minutes += c.minutes
        if (c.kind === 'admin') totals.admin_minutes += c.minutes
        else totals.class_minutes += c.minutes
      }
      return {
        date,
        here: chips.filter((c) => c.here),
        elsewhere: chips.filter((c) => !c.here),
        leave: leave ? { label: leave.label, title: leave.title } : null,
        // Leave says more than "unavailable", as in the Days view (AVAIL.1b).
        unavailable: leave ? null : overlays.unavailableCell(m.profile_id, date),
      }
    })
    return {
      profile_id: m.profile_id,
      full_name: m.full_name || 'Unknown coach',
      member: m.member !== false,
      employment_type: m.employment_type ?? null,
      ...balanceFor(m, totals),
      cells,
      totals,
      leaveDays,
      restGaps: advice.restGapsOf(m.profile_id),
      longWeekMinutes: advice.longWeekOf(m.profile_id),
    }
  })
  rows.sort((a, b) => (a.member === b.member ? 0 : a.member ? -1 : 1)
    || a.full_name.localeCompare(b.full_name)
    || String(a.profile_id).localeCompare(String(b.profile_id)))
  return {
    days,
    rows,
    checked: grid.cross_studio_checked !== false && advice.ok,
    untimed: rows.reduce((n, r) => n + r.totals.untimed, 0),
  }
}

// Program default 4: contract − class − placed admin, every studio, EMPLOYEES
// WITH A CONTRACT ONLY. Hours only: `contracted_hours` is the only contract
// field the route sends, and only for employment_type 'fte'. The model checks
// the type again, so a payload carrying a contractor's old default of 40
// (mig 012) still gets no balance. Leave is NOT deducted (the default's
// literal formula); adminBalanceLabel says so when there is leave.
function balanceFor(m, totals) {
  const isEmployee = m.employment_type === EMPLOYEE_TYPE
  const hours = m.contracted_hours == null || m.contracted_hours === '' ? NaN : Number(m.contracted_hours)
  const contractMinutes = isEmployee && Number.isFinite(hours) && hours > 0 ? Math.round(hours * 60) : null
  if (contractMinutes === null) return { isEmployee, contractMinutes: null, balance: null }
  const minutes = contractMinutes - totals.class_minutes - totals.admin_minutes
  return {
    isEmployee,
    contractMinutes,
    balance: { minutes, state: minutes > 0 ? 'to_place' : minutes < 0 ? 'over' : 'met' },
  }
}

/**
 * What the admin-balance column says for a row: `text` (visible, aria-hidden),
 * `srText` (the same in words for a screen reader, since "−30m" alone reads
 * as a hyphen), `tone` (to_place | met | over | none) and a `title` with the
 * arithmetic. Hours only.
 */
export function adminBalanceLabel(row) {
  if (!row?.balance) {
    if (row?.employment_type === 'contractor') {
      return { text: 'Contractor', tone: 'none', srText: 'contractor, no admin balance', title: 'Contractors have no contracted hours, so there is no admin balance.' }
    }
    if (row?.isEmployee) {
      return { text: 'No contract hours', tone: 'none', srText: 'no contracted hours set', title: 'No contracted weekly hours are set for this employee.' }
    }
    return { text: '—', tone: 'none', srText: 'no admin balance', title: 'No admin balance.' }
  }
  const h = hoursMinutesLabel
  const sum = `${h(row.contractMinutes)} contract − ${h(row.totals.class_minutes)} class − ${h(row.totals.admin_minutes)} placed admin`
  const n = row.leaveDays || 0
  const leaveNote = n > 0 ? `. ${n} day${n === 1 ? '' : 's'} of approved leave this week ${n === 1 ? 'is' : 'are'} not deducted` : ''
  const { minutes, state } = row.balance
  if (state === 'over') {
    return { text: `−${h(-minutes)}`, tone: 'over', srText: `${h(-minutes)} over contract`, title: `${sum} = ${h(-minutes)} over contract${leaveNote}` }
  }
  if (state === 'met') {
    return { text: '0h', tone: 'met', srText: 'contract met', title: `${sum} = contract met${leaveNote}` }
  }
  return { text: h(minutes), tone: 'to_place', srText: `${h(minutes)} of admin to place`, title: `${sum} = ${h(minutes)} to place${leaveNote}` }
}

// Task 4 replaces this stub.
function overlaysFor() {
  return { leaveOn: () => null, unavailableCell: () => null, unavailableDuring: () => false }
}

// Task 5 replaces this stub.
function advisoriesFor() {
  return { ok: true, restGapsOf: () => [], longWeekOf: () => null }
}
