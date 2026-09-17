import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { calculateNextRun } from '@/lib/report-generator'
import { validateBody, uuidLike } from '@/lib/validate'
import { MANAGER_ROLES, reportFrequencySchema } from '@/lib/schemas'
import {
  canViewReportType, isRateReportType, RATE_REPORT_VIEWER_ROLES, RATE_REPORT_TYPES_IN_LIST,
} from '@/lib/report-access'

// STAFFCOST.1 — a schedule for a rate-bearing report (staff_cost) is owner/
// manager/master only at its location: a head coach can neither create one,
// see one in the list, nor deactivate one (404, so its id cannot be probed).
// Who the cron EMAILS is judged separately, per recipient, in
// src/lib/report-recipients.js.

const ScheduledReportSchema = z.object({
  location_id: uuidLike.optional(),
  report_type: z.enum(['staff_hours', 'staff_cost', 'time_off_summary', 'roster_coverage', 'utilisation']),
  report_name: z.string().min(1).max(200),
  // ROSTER-FIX.5 — one definition, shared with the OpenAPI spec, so this
  // enum cannot drift from the table's CHECK again.
  frequency: reportFrequencySchema,
  day_of_week: z.number().int().min(0).max(6).nullable().optional(),
  day_of_month: z.number().int().min(1).max(31).nullable().optional(),
  deliver_email: z.boolean().optional(),
  email_recipients: z.array(z.string().email()).optional(),
  deliver_notification: z.boolean().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
})

// GET /api/schedule/reports/scheduled — List scheduled reports
export async function GET(request) {
  const user = await getCurrentUser()
  // Role is judged at the schedule's location below, never from user.role
  // (the ACTIVE studio's role).
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id') || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()
  let query = db.from('scheduled_reports')
    .select('*, profiles:created_by(full_name)')
    .eq('location_id', locationId)
    .order('created_at', { ascending: false })
  if (!hasRoleAtLocation(user, locationId, RATE_REPORT_VIEWER_ROLES)) {
    query = query.not('report_type', 'in', RATE_REPORT_TYPES_IN_LIST)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  const visible = (data || []).filter(r => canViewReportType(user, r.location_id, r.report_type, { hasRole: hasRoleAtLocation }))
  return NextResponse.json({ success: true, data: visible })
}

// POST /api/schedule/reports/scheduled — Create a scheduled report
export async function POST(request) {
  const user = await getCurrentUser()
  // Role is judged at the schedule's location below, never from user.role
  // (the ACTIVE studio's role).
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, ScheduledReportSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const locationId = body.location_id || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  if (isRateReportType(body.report_type) && !hasRoleAtLocation(user, locationId, RATE_REPORT_VIEWER_ROLES)) {
    return NextResponse.json(
      { success: false, error: 'Only owners and managers can schedule staff cost reports.' },
      { status: 403 },
    )
  }

  const db = createServerClient()
  const record = {
    location_id: locationId,
    created_by: user.id,
    report_type: body.report_type,
    report_name: body.report_name,
    frequency: body.frequency,
    day_of_week: body.day_of_week ?? null,
    day_of_month: body.day_of_month ?? null,
    deliver_email: body.deliver_email || false,
    email_recipients: body.email_recipients || [],
    deliver_notification: body.deliver_notification ?? true,
    parameters: body.parameters || {},
    active: true,
  }

  // Calculate next_run_at using the shared helper
  record.next_run_at = calculateNextRun(record.frequency, record.day_of_week, record.day_of_month)

  const { data, error } = await db.from('scheduled_reports').insert(record).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data }, { status: 201 })
}

// DELETE /api/schedule/reports/scheduled?id=xxx — Deactivate a scheduled report
export async function DELETE(request) {
  const user = await getCurrentUser()
  // Role is judged at the schedule's location below, never from user.role
  // (the ACTIVE studio's role).
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 })

  const db = createServerClient()

  // Verify the scheduled report belongs to a location the caller can manage.
  const { data: report } = await db.from('scheduled_reports')
    .select('location_id, report_type')
    .eq('id', id)
    .single()
  if (!report) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, report.location_id)
  if (guard) return guard
  // An id from the query string names ONE row, so a row the caller may not
  // see answers exactly like a missing one.
  if (!canViewReportType(user, report.location_id, report.report_type, { hasRole: hasRoleAtLocation })) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const { error } = await db.from('scheduled_reports')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true })
}
