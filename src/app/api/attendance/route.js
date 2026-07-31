// GET /api/attendance
//
// Owner/manager/master-only attendance report. Returns one row per
// shift_assignment in the date range, joined with the matched
// staff profile + scheduled times + actual arrival (if stamped).
//
// Status bucketing happens at read time using the same pure helpers
// the webhook receiver uses, so the report is always consistent
// with how arrivals were classified.
//
// Query params:
//   from   YYYY-MM-DD (default: 14 days ago)
//   to     YYYY-MM-DD (default: today)
//   profile_id  uuid (optional — filter to one staff)
//
// Returns:
//   { success: true, rows: [{ ...one assignment per row }], summary: {...} }

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import {
  resolveScheduledAt,
  bucketLateness,
  minutesLate,
} from '@/lib/staff-attendance'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  { permission: 'attendance_reports', location: true },
  async ({ db, locationId, request }) => {
    const url = new URL(request.url)
    const today = new Date()
    const defaultFrom = new Date(today.getTime() - 14 * 24 * 3600_000)
    const fromStr = url.searchParams.get('from') || defaultFrom.toISOString().slice(0, 10)
    const toStr   = url.searchParams.get('to')   || today.toISOString().slice(0, 10)
    const profileFilter = url.searchParams.get('profile_id') || null

    // Validate date format defensively — bad input gives a 400, not
    // a SQL error.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
      return NextResponse.json({ success: false, error: 'invalid_date_format' }, { status: 400 })
    }

    // Pull the location's timezone — needed to render scheduled and
    // actual times as instants for the lateness comparison.
    const { data: location } = await db
      .from('locations')
      .select('id, name, timezone')
      .eq('id', locationId)
      .single()
    if (!location) return NextResponse.json({ success: false, error: 'location_not_found' }, { status: 404 })
    const tz = location.timezone || 'UTC'

    // Pull every assignment in the window for this location.
    let q = db
      .from('shift_assignments')
      // shift_assignments has two FKs to profiles (profile_id +
      // assigned_by) so PostgREST needs the column name as a
      // disambiguator on the embed, otherwise it errors with
      // "more than one relationship was found". `!profile_id` tells
      // it to follow the assigned-coach FK, not the audit one.
      .select(`
        id, profile_id, status, start_time_override,
        block:shift_blocks!inner ( id, location_id, block_date, start_time, end_time ),
        profile:profiles!profile_id ( id, full_name, email, role )
      `)
      .eq('block.location_id', locationId)
      .gte('block.block_date', fromStr)
      .lte('block.block_date', toStr)
      .neq('status', 'cancelled')
      .order('block(block_date)', { ascending: false })
    if (profileFilter) q = q.eq('profile_id', profileFilter)

    const { data: assignments, error: aErr } = await q
    if (aErr) {
      return NextResponse.json({ success: false, error: aErr.message }, { status: 500 })
    }

    // P2.6 — pull every staff_attendance_event matched to one of these
    // assignments so we can surface arrival source on the row. A
    // single shift can be touched by BOTH Access (card tap) AND
    // Protect (face match) within seconds — we want to show that.
    const assignmentIds = (assignments || []).map(a => a.id).filter(Boolean)
    const sourcesByAssignment = new Map() // assignment_id → Set<source>
    if (assignmentIds.length > 0) {
      const { data: events } = await db
        .from('staff_attendance_events')
        .select('matched_assignment_id, source')
        .in('matched_assignment_id', assignmentIds)
        .in('match_outcome', ['matched', 'already_stamped'])
      for (const ev of (events || [])) {
        if (!ev.matched_assignment_id) continue
        if (!sourcesByAssignment.has(ev.matched_assignment_id)) {
          sourcesByAssignment.set(ev.matched_assignment_id, new Set())
        }
        sourcesByAssignment.get(ev.matched_assignment_id).add(ev.source)
      }
    }

    const nowMs = Date.now()
    const rows = (assignments || [])
      .filter((a) => a.block) // defensive — should always be present given !inner above
      .map((a) => {
        const scheduledAt    = resolveScheduledAt(a.block.block_date, a.block.start_time, tz)
        const scheduledEndAt = resolveScheduledAt(a.block.block_date, a.block.end_time, tz)
        const arrivalAt      = a.start_time_override
          ? resolveScheduledAt(a.block.block_date, a.start_time_override, tz)
          : null
        const status = bucketLateness(scheduledAt, arrivalAt, { scheduledEndAt, nowMs })
        const sourceSet = sourcesByAssignment.get(a.id) || new Set()
        return {
          assignment_id: a.id,
          profile_id: a.profile_id,
          profile_name: a.profile?.full_name || a.profile?.email || '—',
          profile_role: a.profile?.role || null,
          block_date: a.block.block_date,
          scheduled_start: a.block.start_time,
          scheduled_end:   a.block.end_time,
          scheduled_at:    scheduledAt?.toISOString() || null,
          arrival_at:      arrivalAt?.toISOString() || null,
          actual_start:    a.start_time_override || null,
          status,
          minutes_late:    minutesLate(scheduledAt, arrivalAt),
          // P2.6 — sources that contributed to the stamp. Empty array
          // when never auto-stamped (manual entry / pending / no-show).
          sources: Array.from(sourceSet).sort(),
        }
      })

    // Summary at the top of the report.
    const summary = rows.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1
      acc.total++
      return acc
    }, { total: 0, on_time: 0, late: 0, no_show: 0, pending: 0 })

    // NOTE: this response used to carry `tailgates`/`tailgate_count` —
    // recent source='protect' events with match_outcome='unknown_user',
    // surfaced so an operator could enrol/link a face. The UniFi Protect
    // receiver was removed 2026-07-31 (never wired up; the query has
    // always returned 0 rows and no new protect events can ever be
    // written), so the panel and its query went with it.
    return NextResponse.json({
      success: true,
      rows,
      summary,
      location: { id: location.id, name: location.name, timezone: tz },
    })
  }
)
