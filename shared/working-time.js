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
// OWNER REVIEW: who is covered. profiles.employment_type of an employee; mig
// 070 pins the column to 'fte' | 'contractor', NOT NULL DEFAULT 'fte'. Every
// reader and rule asks isWorkingTimeCovered, so this is the one line to change.
export const EMPLOYEE_TYPE = 'fte'

/** Is a person of this employment_type covered by the Act's rules here? */
export function isWorkingTimeCovered(employmentType) {
  return employmentType === EMPLOYEE_TYPE
}
// OWNER REVIEW: what a "rest" is measured between. 'working_day' = the last
// end of one block_date to the first start of the next (split shifts inside a
// day never flag each other). 'shift' = every consecutive pair of shifts, the
// literal "end of one shift to the start of the next" reading, which flags
// every split shift. One-line switch; both readings are tested.
export const REST_GAP_SCOPE = 'working_day'
// The copy follows the switch, so flipping it never leaves a screen saying
// "working days" about a per-shift rule.
export const REST_BETWEEN_LABEL = REST_GAP_SCOPE === 'shift' ? 'between shifts' : 'between working days'

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

// The Monday of the Mon-Sun week containing `iso`: the week bucket for
// MAX_WEEK_HOURS. OWNER REVIEW: the Act's 48 hours is an AVERAGE over a
// four-month reference period; this checks each rostered week on its own,
// which flags early (the safe side for an advisory). An average needs a
// longer read, so it would be a second rule, not a change to this bucket.
function weekStartOf(iso) {
  const p = parseDate(iso)
  const ms = Date.UTC(p.y, p.mo - 1, p.d)
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7
  return new Date(ms - sinceMonday * DAY_MS).toISOString().slice(0, 10)
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

/**
 * Per person, each Mon-Sun week (by block_date) whose rostered hours are MORE
 * than `limit`. Real elapsed time, compared in milliseconds, so 48h 15m flags
 * and 48h does not.
 *
 * @returns {Array<{ profile_id, week_start, minutes, shift_count, block_ids: string[], location_ids: string[] }>}
 */
export function weekHoursOver(shifts, limit = MAX_WEEK_HOURS) {
  const limitMs = limit * HOUR_MS
  const weeks = new Map()
  for (const w of windowsOf(shifts)) {
    const weekStart = weekStartOf(w.date)
    const key = `${w.profile_id}|${weekStart}`
    if (!weeks.has(key)) {
      weeks.set(key, { profile_id: w.profile_id, week_start: weekStart, ms: 0, block_ids: [], location_ids: new Set() })
    }
    const acc = weeks.get(key)
    acc.ms += w.endMs - w.startMs
    acc.block_ids.push(w.block_id)
    if (w.location_id) acc.location_ids.add(w.location_id)
  }
  return [...weeks.values()]
    .filter((acc) => acc.ms > limitMs)
    .map((acc) => ({
      profile_id: acc.profile_id,
      week_start: acc.week_start,
      minutes: Math.round(acc.ms / MINUTE_MS),
      shift_count: acc.block_ids.length,
      block_ids: acc.block_ids,
      location_ids: [...acc.location_ids],
    }))
    .sort((a, b) => a.week_start.localeCompare(b.week_start) || String(a.profile_id).localeCompare(String(b.profile_id)))
}

// A slot as a list shows it: the studio is named only when it is ANOTHER one
// (null = the studio being published or assigned at), and location_id stays
// behind.
function displaySlot({ location_id: locationId, ...slot }, hereLocationId) {
  return { ...slot, location_name: hereLocationId && locationId === hereLocationId ? null : (slot.location_name ?? null) }
}

// `people` is a Map or a plain object: id → { full_name, employment_type }.
function personOf(people, id) {
  if (!people || !id) return null
  return (typeof people.get === 'function' ? people.get(id) : people[id]) || null
}

/**
 * The publish preview's list. Covered people only (isWorkingTimeCovered; an
 * unknown type is not flagged). A rest gap is listed when its later day is
 * today or later, one of its two days is in [from, to], and one of its two
 * shifts is at `hereLocationId`. A long week is listed when it overlaps
 * [from, to], has not ended before today, and has a shift at
 * `hereLocationId`. A null bound or a null hereLocationId does not filter.
 *
 * @returns {{
 *   restGaps: Array<{ profile_id, coach_name, rest_minutes, before, after }>,
 *   longWeeks: Array<{ profile_id, coach_name, week_start, minutes, shift_count, studio_count }>,
 * }}
 */
export function workingTimeAdvisories(shifts, {
  people, hereLocationId = null, from = null, to = null, todayIso = null,
  minRestHours = MIN_REST_HOURS, maxWeekHours = MAX_WEEK_HOURS,
} = {}) {
  const covered = (shifts || []).filter((s) => isWorkingTimeCovered(personOf(people, s?.profile_id)?.employment_type))
  const inPeriod = (d) => (!from || d >= from) && (!to || d <= to)
  const isHere = (locationId) => !hereLocationId || locationId === hereLocationId
  const coachName = (id) => personOf(people, id)?.full_name || 'Coach'

  const restGaps = restGapViolations(covered, { minRestHours })
    .filter((v) => (!todayIso || v.after.date >= todayIso)
      && (inPeriod(v.before.date) || inPeriod(v.after.date))
      && (isHere(v.before.location_id) || isHere(v.after.location_id)))
    .map((v) => ({
      profile_id: v.profile_id,
      coach_name: coachName(v.profile_id),
      rest_minutes: v.rest_minutes,
      before: displaySlot(v.before, hereLocationId),
      after: displaySlot(v.after, hereLocationId),
    }))

  const longWeeks = weekHoursOver(covered, maxWeekHours)
    .filter((w) => {
      const weekEnd = addDays(w.week_start, 6)
      return (!todayIso || weekEnd >= todayIso)
        && (!to || w.week_start <= to)
        && (!from || weekEnd >= from)
        && (!hereLocationId || w.location_ids.includes(hereLocationId))
    })
    .map((w) => ({
      profile_id: w.profile_id,
      coach_name: coachName(w.profile_id),
      week_start: w.week_start,
      minutes: w.minutes,
      shift_count: w.shift_count,
      studio_count: w.location_ids.length,
    }))

  return { restGaps, longWeeks }
}

/**
 * The assign picker's question for ONE person: what would adding `candidate`
 * to their shifts create? The caller checks the person is covered.
 *
 *   restGap    the shortest NEW short rest (violations with the candidate,
 *              minus those without it), with the other shift and which side
 *              of the candidate it is on; null when none.
 *   weekHours  the candidate's week total when it is over the limit WITH the
 *              candidate (even if it already was); null otherwise.
 *
 * `shifts` may hold other people and the candidate's own block: both ignored.
 */
export function candidateWorkingTime(shifts, candidate, {
  hereLocationId = null, minRestHours = MIN_REST_HOURS, maxWeekHours = MAX_WEEK_HOURS,
} = {}) {
  const cand = workingWindow(candidate)
  if (!cand) return { restGap: null, weekHours: null }
  const own = (shifts || []).filter((s) => s?.profile_id === cand.profile_id && s.block_id !== cand.block_id)
  const withCandidate = [...own, candidate]

  const pairKey = (v) => `${v.before.block_id}|${v.after.block_id}`
  const existing = new Set(restGapViolations(own, { minRestHours }).map(pairKey))
  const worst = restGapViolations(withCandidate, { minRestHours })
    .filter((v) => !existing.has(pairKey(v)))
    .filter((v) => v.before.block_id === cand.block_id || v.after.block_id === cand.block_id)
    .sort((a, b) => a.rest_minutes - b.rest_minutes)[0]
  const candidateFirst = worst?.before.block_id === cand.block_id
  const restGap = worst
    ? {
      rest_minutes: worst.rest_minutes,
      side: candidateFirst ? 'after' : 'before',
      other: displaySlot(candidateFirst ? worst.after : worst.before, hereLocationId),
    }
    : null

  const weekStart = weekStartOf(cand.date)
  const week = weekHoursOver(withCandidate, maxWeekHours).find((w) => w.week_start === weekStart)
  return { restGap, weekHours: week ? { week_start: weekStart, minutes: week.minutes } : null }
}

// ── Copy ────────────────────────────────────────────────────────────────────

/** 659 → '10h 59m', 660 → '11h', 45 → '45m'. Negative or garbage → '0m'. */
export function hoursMinutesLabel(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h === 0) return `${r}m`
  return r === 0 ? `${h}h` : `${h}h ${r}m`
}

/** Counts PEOPLE: one person over in two weeks is still one employee. */
export function longWeeksHeadline(longWeeks) {
  const n = new Set((longWeeks || []).map((w) => w.profile_id)).size
  return `${n} employee${n === 1 ? '' : 's'} over ${MAX_WEEK_HOURS} hours in a week`
}

export function restGapsHeadline(restGaps) {
  const n = (restGaps || []).length
  return `${n} rest${n === 1 ? '' : 's'} under ${MIN_REST_HOURS} hours ${REST_BETWEEN_LABEL}`
}
