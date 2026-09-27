// src/lib/attendance-report.js
//
// ATTENDREPORT.1 (follow-ups C4) — the attendance report's rules, pure. The
// route (src/app/api/attendance/route.js) checks the query and reads; every
// answer it gives is decided here. The page imports the default period and the
// CSV from here too, so browser and server never disagree about either.
//
// THE RULES
//   Arrived = shift_assignments.arrived_at, nothing else (ARRIVAL.1). The
//   manager's start_time_override / end_time_override (mig 099) are the paid
//   window: never an arrival.
//   Lateness (status, minutes_late, scheduled_at) is measured from the coach's
//   EFFECTIVE start, and pending vs no-show from the EFFECTIVE end: the
//   override, else the block's own time (shared/roster-month.js; the template
//   is unreachable, shift_blocks.start_time is NOT NULL). That is the time the
//   coach was told. Before this PR the report measured from the BLOCK start, so
//   a coach moved to 08:00 read "late +50" for arriving at 07:50.
//   The back-to-back CARRY-OVER (inferContinuousArrivals) stays on the BLOCK's
//   times, on purpose: SNAPSHOT.1's compare (roster-compare.js) and the phone's
//   arrival line (shift-arrivals.js) measure it "as the attendance report
//   does", and the geofence matcher judges its windows on block times too. The
//   tests run the compare on the same rows and require the same answer.
//   A carried arrival is never late (minutes_late null): the coach didn't walk
//   in at that instant.

import { addDaysISO } from './dublin-time'
import { resolveTz } from './tz-time'
import { isRealCalendarDate, uuidLike } from './schemas'
import { reportPeriodError } from './report-period'
import { effectiveShiftStart, effectiveShiftEnd } from '@shared/roster-month'
import {
  resolveScheduledAt, bucketLateness, minutesLate, arrivalToTimeOnly,
  inferContinuousArrivals, effectiveWindowAt,
} from './staff-attendance'

export const DEFAULT_WINDOW_DAYS = 14

/** The page's default period: the 14 days before `today` and today. `today` is dublinTodayStr(). */
export function defaultAttendancePeriod(today) {
  return { from: addDaysISO(today, -DEFAULT_WINDOW_DAYS), to: today }
}

const PERIOD_NAMES = { startName: 'from', endName: 'to' }

/**
 * The report's query, checked before any read.
 * `to` defaults to `today` (the Dublin day), `from` to 14 days before `to`.
 *
 * @param {URLSearchParams} searchParams
 * @param {string} today  YYYY-MM-DD, dublinTodayStr()
 * @returns {{ from: string, to: string, profileId: string|null } | { error: string }}
 */
export function parseAttendanceQuery(searchParams, today) {
  const get = (k) => {
    const v = searchParams?.get?.(k)
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }
  const to = get('to') ?? today
  // Checked before it is counted back from: addDaysISO throws on a bad date.
  if (!isRealCalendarDate(to)) return { error: `${PERIOD_NAMES.startName} and ${PERIOD_NAMES.endName} must be real dates, YYYY-MM-DD` }
  const from = get('from') ?? addDaysISO(to, -DEFAULT_WINDOW_DAYS)
  const periodError = reportPeriodError(from, to, PERIOD_NAMES)
  if (periodError) return { error: periodError }
  const profileId = get('profile_id')
  if (profileId && !uuidLike.safeParse(profileId).success) return { error: 'profile_id must be a UUID' }
  return { from, to, profileId }
}

/** assignment id → Set of the event sources that matched it. */
export function sourcesByAssignment(events) {
  const out = new Map()
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev?.matched_assignment_id || !ev.source) continue
    if (!out.has(ev.matched_assignment_id)) out.set(ev.matched_assignment_id, new Set())
    out.get(ev.matched_assignment_id).add(ev.source)
  }
  return out
}

// The fields effectiveShiftStart/End read, from the report's row shape
// (a shift_assignments row with its block embedded as `block`).
function windowRow(a) {
  return {
    start_time_override: a.start_time_override ?? null,
    end_time_override: a.end_time_override ?? null,
    start_time: a.block?.start_time ?? null,
    end_time: a.block?.end_time ?? null,
  }
}

// 'HH:MM' → 'HH:MM:00'; 'HH:MM:SS[.f]' → 'HH:MM:SS'. For comparing stored times.
function hms(t) {
  const s = String(t ?? '')
  return /^\d{2}:\d{2}$/.test(s) ? `${s}:00` : s.slice(0, 8)
}

const validDate = (v) => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isFinite(d.getTime()) ? d : null
}
const iso = (d) => (d ? d.toISOString() : null)

function rowOrder(x, y) {
  return String(y.block_date).localeCompare(String(x.block_date)) // newest day first
    || hms(x.effective_start).localeCompare(hms(y.effective_start))
    || String(x.profile_name).localeCompare(String(y.profile_name))
    || String(x.assignment_id).localeCompare(String(y.assignment_id))
}

/**
 * @param {object} args
 * @param {object[]} args.assignments  shift_assignments rows with `block` and `profile` embedded
 * @param {object[]} [args.events]     staff_attendance_events { matched_assignment_id, source }
 * @param {string|null} [args.tz]      locations.timezone; unknown → Europe/Dublin
 * @param {number} [args.nowMs]        what pending/no-show is judged against
 * @returns {{ rows: object[], summary: { total, on_time, late, no_show, pending } }}
 */
export function buildAttendanceReport({ assignments, events = [], tz = null, nowMs = Date.now() } = {}) {
  const zone = resolveTz(tz)
  const sources = sourcesByAssignment(events)

  const base = (Array.isArray(assignments) ? assignments : [])
    .filter((a) => a && a.block && a.block.block_date)
    .map((a) => {
      const win = effectiveWindowAt(a.block.block_date, windowRow(a), zone)
      return {
        a,
        profileId: a.profile_id,
        blockDate: a.block.block_date,
        // The carry-over's clock: the BLOCK's times (see the header).
        scheduledAt: resolveScheduledAt(a.block.block_date, a.block.start_time, zone),
        scheduledEndAt: resolveScheduledAt(a.block.block_date, a.block.end_time, zone),
        arrivalAt: validDate(a.arrived_at),
        // Lateness and pending/no-show: the coach's EFFECTIVE window.
        effectiveStartAt: win.start,
        effectiveEndAt: win.end,
      }
    })

  const rows = inferContinuousArrivals(base).map((r) => {
    const a = r.a
    const wr = windowRow(a)
    const arrivedAt = validDate(r.arrivalAt)
    // A stamp recorded straight onto arrived_at carries its own source
    // (arrival_source, mig 609): union it in, so a stamped shift always shows
    // one even when no event row matched (or the events read failed).
    const sourceSet = new Set(sources.get(a.id) || [])
    if (a.arrival_source) sourceSet.add(a.arrival_source)
    return {
      assignment_id: a.id,
      profile_id: a.profile_id,
      profile_name: a.profile?.full_name || a.profile?.email || '—',
      profile_role: a.profile?.role || null,
      block_date: a.block.block_date,
      // The ROSTERED (block) times, unchanged.
      scheduled_start: a.block.start_time,
      scheduled_end: a.block.end_time,
      // What lateness and pending/no-show are judged on.
      effective_start: effectiveShiftStart(wr),
      effective_end: effectiveShiftEnd(wr),
      start_adjusted: !!a.start_time_override && hms(a.start_time_override) !== hms(a.block.start_time),
      // The instant lateness is measured from (the effective start).
      scheduled_at: iso(r.effectiveStartAt),
      arrival_at: iso(arrivedAt),
      actual_start: arrivedAt ? arrivalToTimeOnly(arrivedAt, zone) : null,
      // True when the coach was already on site from a back-to-back shift.
      arrival_inferred: r.arrivalInferred,
      // The manager-set paid start, if any. Not an arrival.
      paid_start_override: a.start_time_override || null,
      status: bucketLateness(r.effectiveStartAt, arrivedAt, { scheduledEndAt: r.effectiveEndAt, nowMs }),
      minutes_late: r.arrivalInferred ? null : minutesLate(r.effectiveStartAt, arrivedAt),
      sources: Array.from(sourceSet).sort(),
    }
  }).sort(rowOrder)

  const summary = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1
    acc.total++
    return acc
  }, { total: 0, on_time: 0, late: 0, no_show: 0, pending: 0 })

  return { rows, summary }
}

export const ATTENDANCE_CSV_HEADER = Object.freeze([
  'Date', 'Staff', 'Role', 'Scheduled start', 'Rostered start', 'Actual start', 'On site (inferred)', 'Status', 'Minutes late',
])

function csvCell(s) {
  const v = String(s ?? '')
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** The page's CSV. "Scheduled start" is the effective start; "Rostered start" the block's. */
export function attendanceCsv(rows) {
  const lines = [ATTENDANCE_CSV_HEADER.join(',')]
  for (const r of Array.isArray(rows) ? rows : []) {
    lines.push([
      r.block_date,
      csvCell(r.profile_name),
      csvCell(r.profile_role || ''),
      r.effective_start || r.scheduled_start || '',
      r.scheduled_start || '',
      r.actual_start || '',
      r.arrival_inferred ? 'yes' : '',
      r.status,
      r.minutes_late ?? '',
    ].join(','))
  }
  return lines.join('\n')
}
