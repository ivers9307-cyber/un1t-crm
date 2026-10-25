// shared/unavailable-days.js
//
// AVAIL.3 D1 (Richard, 3 Oct 2026: "treat like leave"). THE rule for "is
// this person off on this date" in every scheduling reader that used to read
// approved time off only: the week and month copy, the publish budget and
// clash advisory, the assign and bulk-assign warnings, swap conflicts, the
// open-pool cover notice, shift reminders, the schedule overview and the
// time-off reports.
//
// A person is OFF on a date when either covers it:
//   * an APPROVED time_off_requests row (any type), or
//   * an ALL-DAY DATED availability rule (staff_unavailability, kind 'dated',
//     all_day true): "I can't work 11-13 Oct". This is what an Unavailable
//     time-off request became (mig 703 carries the old ones across).
// A part-day rule ("not before 9") and a weekly rule ("never Mondays") stay
// ADVISORY: they shade the grid and rank the picker (GRID.1, CANDIDATES.1)
// and never skip a copy or suppress a reminder.
//
// An availability rule is turned into a LEAVE-SHAPED row (type 'unavailable',
// status 'approved', source 'availability'), so each reader keeps its own
// arithmetic and labels and the day reads exactly like the approved
// Unavailable time off it replaces. The server loader is
// src/lib/unavailable-days.js; tests/leave-readers-availability-guard.test.js
// fails a reader of approved time off that does not use it.

export const AVAILABILITY_LEAVE_SOURCE = 'availability'

const ISO = /^\d{4}-\d{2}-\d{2}$/

/** An all-day dated rule: the availability that counts as leave. */
export function isLeaveLikeAvailabilityRule(rule) {
  return !!rule && rule.kind === 'dated' && rule.all_day === true && !!rule.profile_id
    && ISO.test(String(rule.start_date || '')) && ISO.test(String(rule.end_date || ''))
    && rule.end_date >= rule.start_date
}

// Calendar days, both ends inclusive, from the date strings alone (UTC
// arithmetic on Y-M-D parts, so no clock change can move a day).
function calendarDays(startIso, endIso) {
  const ms = (iso) => {
    const [y, m, d] = iso.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((ms(endIso) - ms(startIso)) / 86400000) + 1
}

/** One leave-like availability rule as an approved Unavailable time-off row. */
export function availabilityLeaveRow(rule) {
  const row = {
    id: `availability:${rule.id}`,
    profile_id: rule.profile_id,
    type: 'unavailable',
    status: 'approved',
    start_date: rule.start_date,
    end_date: rule.end_date,
    total_days: calendarDays(rule.start_date, rule.end_date),
    reason: rule.note ?? null,
    source: AVAILABILITY_LEAVE_SOURCE,
  }
  if (rule.profiles !== undefined) row.profiles = rule.profiles
  return row
}

/** The leave-like rules among `rules`, as leave-shaped rows. */
export function availabilityLeaveRows(rules) {
  return (rules || []).filter(isLeaveLikeAvailabilityRule).map(availabilityLeaveRow)
}

/** Did this row come from availability rather than a time-off request? */
export function isAvailabilityLeave(row) {
  return row?.source === AVAILABILITY_LEAVE_SOURCE
}

/** Does this approved row cover the date? Both ends inclusive (mig 011); ISO strings compare as dates. */
export function coversDate(row, dateIso) {
  return !!row && row.status === 'approved' && !!row.start_date && !!row.end_date
    && row.start_date <= dateIso && row.end_date >= dateIso
}

/** THE decision: is `profileId` off on `dateIso`, given approved leave + availability rows? */
export function isOffOn(rows, profileId, dateIso) {
  return (rows || []).some((r) => r?.profile_id === profileId && coversDate(r, dateIso))
}

/** isOffOn as a lookup, indexed once by person for the loops that ask many times. */
export function offLookup(rows) {
  const byProfile = new Map()
  for (const r of rows || []) {
    if (r?.status !== 'approved' || !r.profile_id) continue
    if (!byProfile.has(r.profile_id)) byProfile.set(r.profile_id, [])
    byProfile.get(r.profile_id).push(r)
  }
  return (profileId, dateIso) => isOffOn(byProfile.get(profileId), profileId, dateIso)
}

/** The assign / bulk-assign advisory line for one row. */
export function leaveWarningLine(name, row) {
  const who = name || 'This coach'
  if (isAvailabilityLeave(row)) {
    return `${who} can’t work from ${row.start_date} to ${row.end_date} (My availability)`
  }
  return `${who} has approved ${row.type} from ${row.start_date} to ${row.end_date}`
}

/** The assign / bulk-assign line when the availability read failed: never a silent "free". */
export function availabilityUncheckedLine(startIso, endIso) {
  const when = !endIso || endIso === startIso ? `on ${startIso}` : `from ${startIso} to ${endIso}`
  return `Could not check My availability ${when}: confirm this coach can work before publishing`
}
