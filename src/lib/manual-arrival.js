// src/lib/manual-arrival.js
//
// ARRIVALFIX.1 — a manager enters a coach's arrival by hand.
//
// shift_assignments.arrived_at is the only arrival (ARRIVAL.1). Until now only
// the phone's geofence check-in wrote it, so a dead phone, a phone left at
// home or a coach who never installed the app left a permanent "no arrival"
// (a no-show on the attendance report) that nobody could fix. mig 609 already
// allows arrival_source 'manual'; this is its first writer.
//
// The rules, all decided here so the route and the page agree:
//   - The time is a wall-clock HH:MM on the shift's own date, at the studio's
//     clock (locations.timezone), never the server's.
//   - It may not be in the future: an arrival is something that happened.
//   - Any stamp may be corrected: a manual one, and (ARRIVALFIX.2) one the
//     phone recorded (arrival_source 'geofence'), which until then could not
//     be fixed when the phone fired late, early or at the wrong shift. The
//     phone's own staff_attendance_events row is never touched, and the
//     correction's event row keeps the previous time and source, so the
//     device's record survives. A corrected stamp becomes 'manual'.
//   - A cancelled assignment is not a shift (404, like a missing one).
//
// Pure: no IO.

import { zonedWallClockToInstant } from '@/lib/location-time'

export const MANUAL_ARRIVAL_SOURCE = 'manual'

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Whether the page offers "Enter arrival" / "Edit" on a report row.
 * @param {{ actual_start?: string|null, arrival_inferred?: boolean, sources?: string[] }} row
 * @returns {'add'|'edit'|null}
 */
export function manualArrivalAction(row) {
  if (!row) return null
  if (!row.actual_start) return 'add'
  // An inferred ("on site") arrival carries no stamp of its own; the coach's
  // earlier shift holds it. Nothing to correct on this row.
  if (row.arrival_inferred) return null
  // ARRIVALFIX.2 — a phone (geofence) arrival is correctable too.
  return 'edit'
}

/**
 * Whether a report row's arrival was recorded by the coach's phone and not
 * yet corrected by hand (the dialog says the phone's record is kept).
 * @param {{ actual_start?: string|null, sources?: string[] }} row
 */
export function isPhoneArrival(row) {
  const sources = Array.isArray(row?.sources) ? row.sources : []
  return !!row?.actual_start && sources.includes('geofence') && !sources.includes(MANUAL_ARRIVAL_SOURCE)
}

/**
 * Decide a manual arrival write.
 *
 * @param {object} args
 * @param {{ id: string, status?: string, arrived_at?: string|null, arrival_source?: string|null,
 *   block: { block_date: string } }|null} args.assignment
 * @param {string} args.time   'HH:MM' at the studio
 * @param {string} args.zone   the studio's IANA zone
 * @param {number} [args.nowMs]
 * @returns {{ ok: true, arrivedAt: string } | { ok: false, status: number, error: string }}
 */
export function decideManualArrival({ assignment, time, zone, nowMs = Date.now() }) {
  if (!assignment || assignment.status === 'cancelled' || !assignment.block?.block_date) {
    return { ok: false, status: 404, error: 'Not found' }
  }
  if (!HHMM.test(String(time ?? ''))) {
    return { ok: false, status: 400, error: 'Use a time as HH:MM (24h).' }
  }
  const ms = zonedWallClockToInstant(assignment.block.block_date, time, zone)
  if (!Number.isFinite(ms)) return { ok: false, status: 400, error: 'That time does not exist on this date.' }
  if (ms > nowMs) return { ok: false, status: 400, error: 'An arrival cannot be in the future.' }
  return { ok: true, arrivedAt: new Date(ms).toISOString() }
}
