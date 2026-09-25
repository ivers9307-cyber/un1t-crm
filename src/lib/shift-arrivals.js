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
//     by mig 610): a stamp at the same instant as the stamp on ANY earlier-
//     starting shift that day, at any studio (mig 610's duplicate_orphan),
//     IS that earlier arrival, so it also reads "on site", never a second
//     walk-in. Display only.
//
// Own rows only. The feed also serves the Team view: a coach or a manager
// gets the field on their OWN rows and null on everybody else's. The read is
// keyed on the caller AND bounded to the caller's own assignment ids, and
// annotateOwnArrivals re-checks profile_id on every row.
//
// Never throws and never fails the roster. Unknown is NEVER absence: a failed
// stamps read gives every row `arrival: null`, which the phone renders as
// nothing, not as "No arrival recorded".

import { logWarn } from './log'
import { resolveScheduledAt, inferContinuousArrivals, arrivalToTimeOnly } from './staff-attendance'
import { geofenceFromLocationSettings, geofenceIsConfigured } from './geofence-attendance'
import { resolveTz, dayStrInTz } from './tz-time'
import { effectiveShiftStart, effectiveShiftEnd } from '@shared/roster-month'

// Review 2 — arrivals are tracked, for the absence rule, only on shifts on or
// after this Dublin date. Stamps before it came from a matcher that has since
// changed (ARRIVAL.1/.2, mig 610) and from coaches never told arrivals are
// shown, so a missing one there means nothing. locations.settings.geofence has
// no enabled_at (checked on prod 25 Sep: enabled, latitude, longitude,
// radius_m, gate_copy only), so this is one estate-wide constant. A stamp
// before it is still shown; only `tracked` is forced false.
export const ARRIVAL_TRACKING_FROM = '2026-09-25'

const ms = (d) => (d instanceof Date ? d.getTime() : NaN)

function nextDateKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + 1))
  const pad = (n) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

// Review 3 — no studio shift runs longer than this. A longer effective window
// is a data error (e.g. an end override that wraps a whole day), and an
// absence judged on it would be wrong for most of a day, so none is sent.
const MAX_WINDOW_MS = 16 * 60 * 60 * 1000

// The EFFECTIVE window as instants (override → block → template, the card's
// times). An end at or before the start ends the next day (payroll's rule).
function effectiveWindow(row, tz) {
  const startT = effectiveShiftStart(row)
  const endT = effectiveShiftEnd(row)
  const start = resolveScheduledAt(row.shift_date, startT, tz)
  let end = resolveScheduledAt(row.shift_date, endT, tz)
  if (start && end && end.getTime() <= start.getTime()) end = resolveScheduledAt(nextDateKey(row.shift_date), endT, tz)
  if (start && end && end.getTime() - start.getTime() > MAX_WINDOW_MS) return { starts_at: null, ends_at: null }
  return {
    starts_at: start && Number.isFinite(start.getTime()) ? start.toISOString() : null,
    ends_at: end && Number.isFinite(end.getTime()) ? end.toISOString() : null,
  }
}

// Ids of rows whose OWN stored stamp is the same instant as the stored stamp
// of ANY strictly earlier-starting shift of the viewer's on the same date, at
// any studio: the double-stamp shape, exactly mig 610's duplicate_orphan (same
// coach, same block_date, same value, t.block_start < s.block_start, no studio
// condition — one ping cannot be two walk-ins). Stored stamps only (the rows
// BEFORE inference), like the migration. Every row here is the viewer's own.
function sameInstantAsEarlier(rows) {
  const out = new Set()
  const stamped = rows.filter((r) => Number.isFinite(ms(r.arrivalAt)) && Number.isFinite(ms(r.scheduledAt)))
  for (const r of stamped) {
    const hit = stamped.some((t) => (
      t.id !== r.id
      && t.blockDate === r.blockDate
      && ms(t.arrivalAt) === ms(r.arrivalAt)
      && ms(t.scheduledAt) < ms(r.scheduledAt)
    ))
    if (hit) out.add(r.id)
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
 * @param {{ now?: Date }} [opts]  the server clock (injected by tests)
 * @returns {Array<object>} new rows, each with `arrival`: an object on the
 *   viewer's own rows (when the stamps read succeeded), otherwise null.
 *   `arrival.as_of` is the server clock at the read: the phone judges any
 *   absence against min(its own now, as_of), so a phone clock set ahead, or a
 *   row kept on screen from an earlier fetch, never reads as a later "now".
 */
export function annotateOwnArrivals(rows, facts, viewerId, { now = new Date() } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const stamps = facts?.stamps instanceof Map ? facts.stamps : null
  if (!viewerId || !stamps) return list.map((r) => ({ ...r, arrival: null }))

  const tzOf = (loc) => resolveTz(facts.timezones instanceof Map ? facts.timezones.get(loc) : null)
  const trackedOf = (loc) => (facts.tracked instanceof Map ? facts.tracked.get(loc) === true : null)
  const asOf = now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString() : null

  // inferContinuousArrivals groups by (profileId, blockDate). Every row here is
  // the viewer's own, so the group key carries the STUDIO instead: an arrival
  // at one studio never makes the coach "on site" at another (the report is
  // per studio too). Block times, like the report.
  //
  // Review 3 — a stamp that does not parse is an arrival we cannot read: that
  // row's whole `arrival` is null (unknown, never an absence), and it is kept
  // out of the chain so it is never carried onto the next shift either.
  const unreadable = new Set()
  for (const r of list) {
    if (!r || r.profile_id !== viewerId) continue
    const s = stamps.get(r.id)
    if (s?.arrived_at && !Number.isFinite(new Date(s.arrived_at).getTime())) unreadable.add(r.id)
  }
  const base = list
    .filter((r) => r && r.profile_id === viewerId && !unreadable.has(r.id))
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
  const dup = sameInstantAsEarlier(base)
  const byId = new Map(inferred.map((b) => [b.id, b]))

  return list.map((r) => {
    if (!r || r.profile_id !== viewerId || unreadable.has(r.id)) return { ...r, arrival: null }
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
        tracked: String(r.shift_date ?? '') < ARRIVAL_TRACKING_FROM ? false : trackedOf(r.location_id),
        ...effectiveWindow(r, tz),
        as_of: asOf,
      },
    }
  })
}

// Ids per stamps query. A coach has a handful of shifts a week, so a chunk
// is far under the 1,000-row select cap and ~4KB of `in.(…)` on the URL
// (the same bound as shift-open-swaps.js).
export const OWN_ARRIVAL_ID_CHUNK = 100

const uniq = (xs) => [...new Set((Array.isArray(xs) ? xs : []).filter(Boolean))]

async function readStamps(db, viewerId, ids) {
  try {
    const out = new Map()
    for (let i = 0; i < ids.length; i += OWN_ARRIVAL_ID_CHUNK) {
      const { data, error } = await db.from('shift_assignments')
        .select('id, arrived_at, arrival_source')
        .eq('profile_id', viewerId)
        .in('id', ids.slice(i, i + OWN_ARRIVAL_ID_CHUNK))
      if (error) throw error
      for (const r of data || []) if (r?.id && r.arrived_at) out.set(r.id, r)
    }
    return out
  } catch (err) {
    logWarn('schedule', 'own arrivals read failed; shifts returned without arrival', { err: err?.message || String(err) })
    return null
  }
}

// Tracking = the studio's geofence is configured AND the caller is not exempt
// there: the same rule GET /api/attendance/geofence-config uses to pick the
// regions the phone registers. Timezones survive a failed membership read.
async function readTracking(db, viewerId, locIds) {
  const timezones = new Map()
  if (locIds.length === 0) return { timezones, tracked: new Map() }
  try {
    const [locRes, linkRes] = await Promise.all([
      db.from('locations').select('id, timezone, settings').in('id', locIds),
      db.from('profile_locations').select('location_id, geofence_exempt').eq('profile_id', viewerId).in('location_id', locIds),
    ])
    if (locRes.error) throw locRes.error
    for (const l of locRes.data || []) timezones.set(l.id, l.timezone ?? null)
    if (linkRes.error) throw linkRes.error
    const notExempt = new Set((linkRes.data || []).filter((l) => !l.geofence_exempt).map((l) => l.location_id))
    const tracked = new Map()
    for (const l of locRes.data || []) {
      tracked.set(l.id, notExempt.has(l.id) && geofenceIsConfigured(geofenceFromLocationSettings(l.settings)))
    }
    return { timezones, tracked }
  } catch (err) {
    logWarn('schedule', 'arrival tracking read failed; absence will not be shown', { err: err?.message || String(err) })
    return { timezones, tracked: null }
  }
}

/**
 * Facts for annotateOwnArrivals. Bounded twice: keyed on the caller (a per-user
 * row: the owner check IS the access rule) and on the caller's own assignment
 * ids / studios in the payload. A caller with no own row costs no query.
 * Never throws: a failed read is `null` (unknown), never "no arrival".
 */
export async function fetchOwnArrivalFacts(db, viewerId, ownIds, locationIds) {
  const ids = uniq(ownIds)
  const locs = uniq(locationIds)
  if (!viewerId || ids.length === 0) return { stamps: new Map(), timezones: new Map(), tracked: new Map() }
  const [stamps, tracking] = await Promise.all([readStamps(db, viewerId, ids), readTracking(db, viewerId, locs)])
  return { stamps, ...tracking }
}
