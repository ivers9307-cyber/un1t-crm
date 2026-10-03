// GET /api/attendance
//
// The attendance report (/schedule/attendance): one row per live
// shift_assignment at the caller's ACTIVE studio in [from, to], with the coach,
// the times they were given, the arrival the app recorded
// (shift_assignments.arrived_at, ARRIVAL.1) and a status.
//
// ACCESS: the attendance_reports permission (owner / manager / master by
// default; off for staff, reception and head coaches), judged at the active
// studio, and every read is keyed on that same studio. The role and the rows
// come from one place, so the path-vs-active-studio class (SCHEDROLES, B1/C7)
// cannot arise here.
//
// The rules (effective start/end, the back-to-back carry, the summary, the
// CSV) live in src/lib/attendance-report.js. This file checks the query and
// reads.
//
// ATTENDREPORT.1 (follow-ups C4):
//   - from/to must be real dates, to on or after from, at most 366 days
//     (reportPeriodError); the defaults are the DUBLIN day (dublinTodayStr),
//     never the server's UTC day. All refused before any read.
//   - every assignment is read (.range() pages ordered by id: PostgREST returns
//     at most 1,000 rows, silently), and the events read goes in chunks of 100
//     ids (a year of ids on one URL was ~32KB).
//   - a failed read is never an answer: a failed location or assignments read
//     is a logged 500 (never "not found", never the raw database message); a
//     failed events read keeps the report and says so, because events only
//     feed the Source badges and every stamped row carries its own
//     arrival_source.
//
// Query params:
//   from        YYYY-MM-DD (default: 14 days before `to`)
//   to          YYYY-MM-DD (default: today in Dublin)
//   profile_id  uuid (optional: one coach)
//
// Returns:
//   { success: true, rows: [...], summary: {...}, warnings: [] | ['sources_unavailable'],
//     location: { id, name, timezone } }

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { dublinTodayStr } from '@/lib/dublin-time'
import { selectAll, selectAllByKeys } from '@/lib/select-all'
import { resolveTz } from '@/lib/tz-time'
import { logError } from '@/lib/log'
import { parseAttendanceQuery, buildAttendanceReport } from '@/lib/attendance-report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Assignment ids per events query: ~4KB of `in.(…)` (shift-arrivals.js's bound).
const EVENT_ID_CHUNK = 100

// shift_assignments has two FKs to profiles (profile_id + assigned_by), so the
// profile embed names its column: `!profile_id` follows the assigned coach.
const ASSIGNMENT_COLUMNS = `
  id, profile_id, status, arrived_at, arrival_source, start_time_override, end_time_override,
  block:shift_blocks!inner ( id, location_id, block_date, start_time, end_time ),
  profile:profiles!profile_id ( id, full_name, email, role )
`

const LOAD_FAILED = 'Could not load the attendance report. Try again.'
const failed = () => NextResponse.json({ success: false, error: LOAD_FAILED }, { status: 500 })

export const GET = withAuth(
  { permission: 'attendance_reports', location: true },
  async ({ db, locationId, request }) => {
    const query = parseAttendanceQuery(new URL(request.url).searchParams, dublinTodayStr())
    if (query.error) return NextResponse.json({ success: false, error: query.error }, { status: 400 })
    const { from, to, profileId } = query

    // The studio's timezone turns stored wall-clock times into instants.
    const { data: location, error: locationError } = await db
      .from('locations')
      .select('id, name, timezone')
      .eq('id', locationId)
      .maybeSingle()
    if (locationError) {
      logError('attendance', 'location read failed', { locationId, error: locationError.message })
      return failed()
    }
    if (!location) return NextResponse.json({ success: false, error: 'location_not_found' }, { status: 404 })
    const tz = resolveTz(location.timezone)

    let assignments
    try {
      assignments = await selectAll((lo, hi) => {
        let q = db
          .from('shift_assignments')
          .select(ASSIGNMENT_COLUMNS)
          .eq('block.location_id', locationId)
          .gte('block.block_date', from)
          .lte('block.block_date', to)
          .neq('status', 'cancelled')
        if (profileId) q = q.eq('profile_id', profileId)
        return q.order('id', { ascending: true }).range(lo, hi)
      })
    } catch (e) {
      logError('attendance', 'assignments read failed', { locationId, from, to, error: e?.message || String(e) })
      return failed()
    }

    // P2.6 — the event sources that matched each assignment. One shift can be
    // matched by more than one source, and old rows carry the retired UniFi
    // sources ('unifi_access', 'protect'), which the page still labels.
    const warnings = []
    let events = []
    const assignmentIds = assignments.map((a) => a.id).filter(Boolean)
    if (assignmentIds.length > 0) {
      try {
        events = await selectAllByKeys(
          assignmentIds,
          (ids, lo, hi) => db
            .from('staff_attendance_events')
            .select('id, matched_assignment_id, source')
            .in('matched_assignment_id', ids)
            .in('match_outcome', ['matched', 'already_stamped'])
            .order('id', { ascending: true })
            .range(lo, hi),
          { chunkSize: EVENT_ID_CHUNK },
        )
      } catch (e) {
        logError('attendance', 'attendance events read failed', {
          locationId, from, to, assignments: assignmentIds.length, error: e?.message || String(e),
        })
        warnings.push('sources_unavailable')
      }
    }

    const { rows, summary } = buildAttendanceReport({ assignments, events, tz, nowMs: Date.now() })

    // NOTE: this response used to carry `tailgates`/`tailgate_count`: recent
    // source='protect' events with match_outcome='unknown_user', so an operator
    // could enrol a face. The UniFi Protect receiver was removed 2026-07-31
    // (never wired up), so the panel and its query went with it.
    return NextResponse.json({
      success: true,
      rows,
      summary,
      warnings,
      location: { id: location.id, name: location.name, timezone: tz },
    })
  }
)
