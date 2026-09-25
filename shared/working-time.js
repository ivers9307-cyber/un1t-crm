// WORKTIME.1 — working-time advisories for EMPLOYEES.
//
// Two rules from the Organisation of Working Time Act, ADVISORY ONLY: nothing
// here may block an assign or a publish.
//
//   restGapViolations  fewer than 11 hours between the END of the last shift
//                      of one working day and the START of the first shift of
//                      the next. Shifts inside one day (a 06:30 class and an
//                      18:00 class) are one working day: the Act asks for 11
//                      CONSECUTIVE hours in each 24, which the overnight gap
//                      gives or does not. Every-pair checking would flag every
//                      split shift in the estate.
//   weekHoursOver      more than 48 rostered hours in a Monday-to-Sunday week.
//                      The Act averages over four months; this checks each
//                      rostered week on its own, so it flags EARLY, which is
//                      the safe side for an advisory (Scheduler Wave 2 default 3).
//
// Inputs are shift rows from EVERY studio of the person's organisation (the
// reader is src/lib/working-time-data.js). Only an employee is covered by the
// Act: workingTimeAdvisories filters to EMPLOYEE_TYPE itself, and the picker
// route asks per employee.
//
// Times: `block_date` + HH:MM is Europe/Dublin WALL CLOCK. It is turned into a
// real instant here (dublinWallMs) because rest is elapsed time: the night the
// clocks go back is an hour longer than its wall clock says, the night they go
// forward an hour shorter. Never `new Date(`${d}T${t}Z`)` (CLAUDE.md).
// The window per assignment is override → block → template: effectiveShiftStart
// / effectiveShiftEnd, the one resolution payroll's shiftHours also uses.
//
// Pure, no IO. In shared/ because the phone's candidate list (CANDIDATES.1)
// runs the same rule. Hours only: no rate, cost or contract figure is read or
// returned.

import { effectiveShiftStart, effectiveShiftEnd } from './roster-month.js'

export const MIN_REST_HOURS = 11
export const MAX_WEEK_HOURS = 48
// profiles.employment_type of an employee. Mig 070 pins the column to
// 'fte' | 'contractor', NOT NULL DEFAULT 'fte'. Nothing else is covered.
export const EMPLOYEE_TYPE = 'fte'
// OWNER REVIEW: what a "rest" is measured between. 'working_day' = the last
// end of one block_date to the first start of the next (split shifts inside a
// day never flag each other). 'shift' = every consecutive pair of shifts, the
// literal "end of one shift to the start of the next" reading, which flags
// every split shift. One-line switch; both readings are tested.
export const REST_GAP_SCOPE = 'working_day'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseTime(value) {
  const m = String(value ?? '').match(TIME_RE)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  const s = m[3] ? Number(m[3]) : 0
  if (h > 23 || mi > 59 || s > 59) return null
  return { h, mi, s }
}

function parseDate(value) {
  const m = String(value ?? '').match(DATE_RE)
  return m ? { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } : null
}

// Calendar arithmetic on YYYY-MM-DD strings through Date.UTC: no host timezone
// and no 23h/25h day can move a date. Private on purpose: src/lib already
// exports addDaysISO and mondayOf, and tests/shared-pair-sync.test.js makes a
// shared export NAME a pair someone must classify.
function addDays(iso, n) {
  const p = parseDate(iso)
  return new Date(Date.UTC(p.y, p.mo - 1, p.d) + n * DAY_MS).toISOString().slice(0, 10)
}

// Europe/Dublin wall-clock parts for an instant. Same formatter shape as
// shared/dublin-time.js (which normalises the same '24' midnight quirk).
const WALL_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Dublin',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
})

// How far Dublin's wall clock is ahead of UTC at instant `ms`: 0 in winter
// (GMT), one hour in summer (IST).
function dublinOffsetMs(ms) {
  const p = {}
  for (const { type, value } of WALL_FMT.formatToParts(new Date(ms))) p[type] = value
  const hour = p.hour === '24' ? 0 : Number(p.hour)
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second)) - ms
}

// The real instant of a Dublin wall-clock date + time. Read the wall time as if
// it were UTC, correct by Dublin's offset, then correct again with the offset
// AT the corrected instant. The second pass matters only inside the skipped
// spring-forward hour (a wall 01:30 on 29 Mar 2026 lands on 02:30 IST, never
// on 00:30 GMT); every real wall time is right after either pass.
// shared/dublin-time.js dublinDayStartMs does the one-pass version for midnight.
function dublinWallMs(date, time) {
  const naive = Date.UTC(date.y, date.mo - 1, date.d, time.h, time.mi, time.s)
  const first = naive - dublinOffsetMs(naive)
  return naive - dublinOffsetMs(first)
}

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * One assignment as a working window, or null when it is not one: cancelled,
 * no person, a date or time that does not parse, or zero length (shiftHours
 * gives such a row 0 hours too). An end before the start runs into the next
 * day: an overnight shift cannot be created today, so this is defence, not a
 * feature. The window belongs to its block_date for working days and weeks.
 *
 * @param {{ profile_id, block_id?, block_date, location_id?, location_name?,
 *   name?, status?, start_time_override?, end_time_override?, start_time?,
 *   end_time?, block_start_time?, block_end_time?, shift_templates? }} row
 */
export function workingWindow(row) {
  if (!row?.profile_id || row.status === 'cancelled') return null
  const date = parseDate(row.block_date)
  const start = parseTime(effectiveShiftStart(row))
  const end = parseTime(effectiveShiftEnd(row))
  if (!date || !start || !end) return null
  const startSecs = start.h * 3600 + start.mi * 60 + start.s
  const endSecs = end.h * 3600 + end.mi * 60 + end.s
  if (endSecs === startSecs) return null
  const endDate = endSecs < startSecs ? parseDate(addDays(row.block_date, 1)) : date
  return {
    profile_id: row.profile_id,
    block_id: row.block_id ?? null,
    date: row.block_date,
    location_id: row.location_id ?? null,
    location_name: row.location_name ?? null,
    name: row.name || 'Shift',
    start: `${pad2(start.h)}:${pad2(start.mi)}`,
    end: `${pad2(end.h)}:${pad2(end.mi)}`,
    startMs: dublinWallMs(date, start),
    endMs: dublinWallMs(endDate, end),
  }
}

// Every usable window, once per (person, block): the same block reached by two
// reads must not count twice.
function windowsOf(shifts) {
  const seen = new Set()
  const out = []
  for (const row of shifts || []) {
    const w = workingWindow(row)
    if (!w) continue
    const key = `${w.profile_id}|${w.block_id ?? `${w.date}|${w.start}|${w.end}|${w.location_id}`}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(w)
  }
  return out
}

const slotOf = (w) => ({
  block_id: w.block_id,
  date: w.date,
  start: w.start,
  end: w.end,
  name: w.name,
  location_id: w.location_id,
  location_name: w.location_name,
})

// One person's windows as the UNITS a rest is measured between, in order:
// { first, last } = the unit's earliest-starting and latest-ending window.
//   'working_day'  one unit per block_date (split shifts inside a day are one
//                  working day; the overnight gap is the rest).
//   'shift'        one unit per shift (every consecutive pair is a rest).
function restUnits(windows, restScope) {
  if (restScope === 'shift') {
    return [...windows]
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
      .map((w) => ({ first: w, last: w }))
  }
  const byDate = new Map()
  for (const w of windows) {
    const day = byDate.get(w.date)
    if (!day) {
      byDate.set(w.date, { first: w, last: w })
      continue
    }
    if (w.startMs < day.first.startMs) day.first = w
    if (w.endMs > day.last.endMs) day.last = w
  }
  return [...byDate.keys()].sort().map((d) => byDate.get(d))
}

/**
 * Per person, each pair of consecutive rest units (working days by default,
 * REST_GAP_SCOPE) whose rest (the later unit's first start minus the earlier
 * unit's latest end) is under `minRestHours`. A negative rest (an overnight
 * shift running into the next day's first) reports 0.
 *
 * @returns {Array<{ profile_id, rest_minutes, before: Slot, after: Slot }>}
 *   Slot = { block_id, date, start, end, name, location_id, location_name }
 */
export function restGapViolations(shifts, { minRestHours = MIN_REST_HOURS, restScope = REST_GAP_SCOPE } = {}) {
  const minMs = minRestHours * HOUR_MS
  const byPerson = new Map()
  for (const w of windowsOf(shifts)) {
    if (!byPerson.has(w.profile_id)) byPerson.set(w.profile_id, [])
    byPerson.get(w.profile_id).push(w)
  }

  const out = []
  for (const [profileId, windows] of byPerson) {
    const units = restUnits(windows, restScope)
    for (let i = 1; i < units.length; i++) {
      const before = units[i - 1].last
      const after = units[i].first
      const restMs = after.startMs - before.endMs
      if (restMs >= minMs) continue
      out.push({
        profile_id: profileId,
        rest_minutes: Math.max(0, Math.floor(restMs / MINUTE_MS)),
        before: slotOf(before),
        after: slotOf(after),
      })
    }
  }
  return out.sort((a, b) =>
    a.after.date.localeCompare(b.after.date)
    || a.after.start.localeCompare(b.after.start)
    || String(a.profile_id).localeCompare(String(b.profile_id)))
}
