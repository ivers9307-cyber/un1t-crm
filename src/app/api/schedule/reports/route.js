import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, getUserLocationIds, hasRoleAtLocation } from '@/lib/auth'
import { generateReport } from '@/lib/report-generator'
import { validateBody } from '@/lib/validate'
import { uuidLike, realIsoDate, reportTypeSchema, MANAGER_ROLES } from '@/lib/schemas'
import {
  canViewReportType, isRateReportType, RATE_REPORT_VIEWER_ROLES, RATE_REPORT_TYPES_IN_LIST,
} from '@/lib/report-access'

// STAFFCOST.1 — every check is made at the REPORT's location via
// rolesByLocation: MANAGER_ROLES to use reporting at all, and owner/manager/
// master for rate-bearing types (staff_cost). The routes used to gate on
// MANAGER_ROLES.includes(user.role) — the ACTIVE studio's role — and then
// accept any location the caller belonged to, so a manager at one studio who
// is staff at another read the other's reports, staff cost included. See
// src/lib/report-access.js for the per-type decision. There is no by-id read
// or download route for generated reports: this list IS the read path (the
// history view opens rows from it), so it is where the filter has to live.

const ReportRunSchema = z.object({
  report_type: reportTypeSchema,
  // DATECHECK.1 — real dates, not just the shape.
  period_start: realIsoDate,
  period_end: realIsoDate,
  location_id: uuidLike.optional(),
})

const forbidden = () => NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

// GET /api/schedule/reports?location_id=xxx — List generated reports
export async function GET(request) {
  const user = await getCurrentUser()
  // Role is judged per studio below, never from the ACTIVE studio's user.role.
  if (!user) return forbidden()

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  let query = db.from('generated_reports')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)

  if (locationId) {
    if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) return forbidden()
    query = query.eq('location_id', locationId)
    if (!hasRoleAtLocation(user, locationId, RATE_REPORT_VIEWER_ROLES)) {
      query = query.not('report_type', 'in', RATE_REPORT_TYPES_IN_LIST)
    }
  } else {
    // Only locations where the caller manages reporting at all, and within
    // those, rate reports only where they hold an admin role.
    const managedIds = getUserLocationIds(user).filter(id => hasRoleAtLocation(user, id, MANAGER_ROLES))
    if (managedIds.length === 0) return NextResponse.json({ success: true, data: [] })
    query = query.in('location_id', managedIds)
    const rateIds = managedIds.filter(id => hasRoleAtLocation(user, id, RATE_REPORT_VIEWER_ROLES))
    if (rateIds.length === 0) {
      query = query.not('report_type', 'in', RATE_REPORT_TYPES_IN_LIST)
    } else if (rateIds.length < managedIds.length) {
      query = query.or(`location_id.in.(${rateIds.join(',')}),report_type.not.in.${RATE_REPORT_TYPES_IN_LIST}`)
    }
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  // Defence in depth: the query already excludes them, but a report row with
  // rates must never cross the wire because a filter string was wrong.
  const visible = (data || []).filter(r => canViewReportType(user, r.location_id, r.report_type, { hasRole: hasRoleAtLocation }))
  return NextResponse.json({ success: true, data: visible })
}

// POST /api/schedule/reports — Generate a report on demand
export async function POST(request) {
  const user = await getCurrentUser()
  // Role is judged per studio below, never from the ACTIVE studio's user.role.
  if (!user) return forbidden()

  const validation = await validateBody(request, ReportRunSchema)
  if (!validation.ok) return validation.response
  const { report_type, period_start, period_end, location_id } = validation.data
  const locId = location_id || user.activeLocation?.id

  const guard = assertLocationAccess(user, locId)
  if (guard) return guard

  // The location and type are caller-supplied (body), so a refusal is a 403 —
  // the 404 rule is for ids read from a path.
  if (!hasRoleAtLocation(user, locId, MANAGER_ROLES)) return forbidden()
  if (isRateReportType(report_type) && !hasRoleAtLocation(user, locId, RATE_REPORT_VIEWER_ROLES)) {
    return NextResponse.json(
      { success: false, error: 'Only owners and managers can run staff cost reports.' },
      { status: 403 },
    )
  }

  const result = await generateReport({
    report_type,
    period_start,
    period_end,
    location_id: locId,
    generated_by: user.id,
  })

  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: result.data }, { status: 201 })
}
