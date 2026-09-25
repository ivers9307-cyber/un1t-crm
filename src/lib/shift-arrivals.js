// src/lib/shift-arrivals.js
//
// ARRIVALSHOW.1 — "did the app record my arrival for this shift?" for
// GET /api/schedule/shifts, so the phone's Schedule tab (Me view) can show a
// coach their OWN arrival stamp. The first half of late/no-show alerts: the
// coach sees exactly what an alert would later judge.
//
// What "arrived" means (the table in the ARRIVALSHOW.1 plan):
//   - shift_assignments.arrived_at (mig 609) is the ONLY arrival. The geofence
//     check-in writes it (arrival_source 'geofence'); 'manual' is allowed by
//     the CHECK but nothing writes it yet.
//   - start_time_override / end_time_override are the MANAGER-set paid window
//     (mig 099). They are never an arrival (ARRIVAL.1; mig 610 moved the old
//     geofence stamps out). They only move the window an absence is judged
//     on, because that is the time the coach's card shows.
//   - No stamp, but an earlier same-day shift at the SAME studio has an
//     arrival and this one starts within 60 minutes of its BLOCK end: "on
//     site" (the attendance report's rule, inferContinuousArrivals).
//   - The double-stamp shape (16 Sep review; fixed by ARRIVAL.1/.2, cleaned
//     by mig 610): a stamp at the same instant as the earlier same-day
//     shift's arrival at the same studio IS that earlier arrival, so it also
//     reads "on site", never a second walk-in. Display only.
//
// Own rows only. The feed also serves the Team view: a coach or a manager
// gets the field on their OWN rows and null on everybody else's. The read is
// keyed on the caller AND bounded to the caller's own assignment ids, and
// annotateOwnArrivals re-checks profile_id on every row.
//
// Never throws and never fails the roster. Unknown is NEVER absence: a failed
// stamps read gives every row `arrival: null`, which the phone renders as
// nothing, not as "No arrival recorded".

import { resolveScheduledAt, inferContinuousArrivals, arrivalToTimeOnly } from './staff-attendance'
import { resolveTz, dayStrInTz } from './tz-time'
import { effectiveShiftStart, effectiveShiftEnd } from '@shared/roster-month'

const ms = (d) => (d instanceof Date ? d.getTime() : NaN)
const sortMs = (d) => { const v = ms(d); return Number.isFinite(v) ? v : Infinity }

function nextDateKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + 1))
  const pad = (n) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

// The EFFECTIVE window as instants (override → block → template, the card's
// times). An end at or before the start ends the next day (payroll's rule).
function effectiveWindow(row, tz) {
  const startT = effectiveShiftStart(row)
  const endT = effectiveShiftEnd(row)
  const start = resolveScheduledAt(row.shift_date, startT, tz)
  let end = resolveScheduledAt(row.shift_date, endT, tz)
  if (start && end && end.getTime() <= start.getTime()) end = resolveScheduledAt(nextDateKey(row.shift_date), endT, tz)
  return {
    starts_at: start && Number.isFinite(start.getTime()) ? start.toISOString() : null,
    ends_at: end && Number.isFinite(end.getTime()) ? end.toISOString() : null,
  }
}

// Ids of rows whose OWN stamp is the same instant as the previous shift's
// arrival (same studio, same date): the double-stamp shape.
function sameInstantAsEarlier(rows) {
  const out = new Set()
  const ordered = [...rows].sort((a, b) => (
    a.profileId.localeCompare(b.profileId)
    || String(a.blockDate).localeCompare(String(b.blockDate))
    || sortMs(a.scheduledAt) - sortMs(b.scheduledAt)
  ))
  let prev = null
  for (const r of ordered) {
    if (
      prev && prev.profileId === r.profileId && prev.blockDate === r.blockDate
      && !r.arrivalInferred && r.arrivalAt && prev.arrivalAt
      && new Date(r.arrivalAt).getTime() === new Date(prev.arrivalAt).getTime()
    ) out.add(r.id)
    prev = r
  }
  return out
}

/**
 * The caller's own studios in this payload (for the tracking read).
 * De-duplicated, in first-seen order; never a colleague's row.
 */
export function ownLocationIds(rows, viewerId) {
  if (!viewerId) return []
  const ids = new Set()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.location_id && r.profile_id === viewerId) ids.add(r.location_id)
  }
  return [...ids]
}

/**
 * @param {Array<object>} rows toApiShiftRow() results (id = the assignment id)
 * @param {{ stamps: Map<string,{arrived_at:string,arrival_source:string|null}>|null,
 *           timezones: Map<string,string|null>|null,
 *           tracked: Map<string,boolean>|null }} facts  fetchOwnArrivalFacts()
 * @param {string|null} viewerId
 * @returns {Array<object>} new rows, each with `arrival`: an object on the
 *   viewer's own rows (when the stamps read succeeded), otherwise null.
 */
export function annotateOwnArrivals(rows, facts, viewerId) {
  const list = Array.isArray(rows) ? rows : []
  const stamps = facts?.stamps instanceof Map ? facts.stamps : null
  if (!viewerId || !stamps) return list.map((r) => ({ ...r, arrival: null }))

  const tzOf = (loc) => resolveTz(facts.timezones instanceof Map ? facts.timezones.get(loc) : null)
  const trackedOf = (loc) => (facts.tracked instanceof Map ? facts.tracked.get(loc) === true : null)

  // inferContinuousArrivals groups by (profileId, blockDate). Every row here is
  // the viewer's own, so the group key carries the STUDIO instead: an arrival
  // at one studio never makes the coach "on site" at another (the report is
  // per studio too). Block times, like the report.
  const base = list
    .filter((r) => r && r.profile_id === viewerId)
    .map((r) => {
      const tz = tzOf(r.location_id)
      const s = stamps.get(r.id)
      return {
        id: r.id,
        profileId: String(r.location_id ?? ''),
        blockDate: r.shift_date,
        scheduledAt: resolveScheduledAt(r.shift_date, r.block_start_time, tz),
        scheduledEndAt: resolveScheduledAt(r.shift_date, r.block_end_time, tz),
        arrivalAt: s?.arrived_at ? new Date(s.arrived_at) : null,
        source: s?.arrived_at ? (s.arrival_source ?? null) : null,
      }
    })
  const inferred = inferContinuousArrivals(base)
  const dup = sameInstantAsEarlier(inferred)
  const byId = new Map(inferred.map((b) => [b.id, b]))

  return list.map((r) => {
    if (!r || r.profile_id !== viewerId) return { ...r, arrival: null }
    const b = byId.get(r.id)
    const tz = tzOf(r.location_id)
    const at = b?.arrivalAt ? new Date(b.arrivalAt) : null
    const atOk = at && Number.isFinite(at.getTime())
    return {
      ...r,
      arrival: {
        at: atOk ? at.toISOString() : null,
        at_local: atOk ? arrivalToTimeOnly(at, tz).slice(0, 5) : null,
        at_local_date: atOk ? dayStrInTz(at, tz) : null,
        source: b?.arrivalInferred ? null : (b?.source ?? null),
        carried: !!b?.arrivalInferred || dup.has(r.id),
        tracked: trackedOf(r.location_id),
        ...effectiveWindow(r, tz),
      },
    }
  })
}
