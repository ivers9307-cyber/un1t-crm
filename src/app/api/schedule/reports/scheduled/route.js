import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { calculateNextRun } from '@/lib/report-generator'
import { validateBody, uuidLike } from '@/lib/validate'
import { MANAGER_ROLES, reportFrequencySchema, reportTypeSchema } from '@/lib/schemas'
import {
  canViewReportType, isRateReportType, RATE_REPORT_VIEWER_ROLES, RATE_REPORT_TYPES_IN_LIST,
} from '@/lib/report-access'
import { checkRateReportRecipientsForSave } from '@/lib/report-recipients'

// STAFFCOST.1 — a schedule for a rate-bearing report (staff_cost) is owner/
// manager/master only at its location: a head coach can neither create one,
// see one in the list, nor deactivate one (404, so its id cannot be probed).
// Who the cron EMAILS is judged separately, per recipient, in
// src/lib/report-recipients.js.
//
// REPORTS.2 — schedules can be paused, resumed, edited (PATCH) and deleted
// (DELETE, which deactivates). Three more rules:
//   - PATCH is gated exactly like create: the role is judged at the
//     SCHEDULE's location, a schedule the caller may not see answers 404, and
//     changing the report type to one the caller may not schedule is 403.
//   - "In-app notification" delivery is refused on create and edit. It never
//     created a notification (the cron only stamped a flag).
//   - A staff_cost schedule may email only (a) staff with an owner/manager
//     role at the studio or (b) addresses the caller confirms as external
//     (`confirm_external: true`), recorded per address in
//     confirmed_external_recipients (mig 617). A staff address without that
//     role is refused outright; an unconfirmed external one answers 409 with
//     the addresses to confirm, and nothing is saved.

const ScheduledReportSchema = z.object({
  location_id: uuidLike.optional(),
  report_type: reportTypeSchema,
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
  confirm_external: z.boolean().optional(),
})

// Every field optional; location_id deliberately absent — a schedule does not
// move studios (that would be a delete and a create, each gated at its own
// location).
const ScheduledReportPatchSchema = z.object({
  paused: z.boolean().optional(),
  report_type: reportTypeSchema.optional(),
  report_name: z.string().min(1).max(200).optional(),
  frequency: reportFrequencySchema.optional(),
  day_of_week: z.number().int().min(0).max(6).nullable().optional(),
  day_of_month: z.number().int().min(1).max(31).nullable().optional(),
  deliver_email: z.boolean().optional(),
  email_recipients: z.array(z.string().email()).optional(),
  deliver_notification: z.boolean().optional(),
  confirm_external: z.boolean().optional(),
})

const NOTIFICATION_REFUSED = 'In-app notification delivery is no longer offered. Reports always appear in Report History; use email to have them sent.'
const RATE_SCHEDULE_REFUSED = 'Only owners and managers can schedule staff cost reports.'

function cleanRecipients(list) {
  const seen = new Set()
  const out = []
  for (const raw of list || []) {
    const email = String(raw || '').trim()
    const key = email.toLowerCase()
    if (!email || seen.has(key)) continue
    seen.add(key)
    out.push(email)
  }
  return out
}

/**
 * The recipient rule for a save. Returns { response } to answer with, or
 * { confirmedExternal } to store.
 */
async function checkRecipientsForSave({ db, locationId, reportType, deliverEmail, recipients, previouslyConfirmed, confirmExternal }) {
  if (!isRateReportType(reportType) || !deliverEmail || recipients.length === 0) {
    return { confirmedExternal: [] }
  }
  const check = await checkRateReportRecipientsForSave({
    db, locationId, recipients, previouslyConfirmed, confirmExternal: confirmExternal === true,
  })
  if (check.lookupFailed) {
    return { response: NextResponse.json(
      { success: false, error: 'Could not check the recipients just now, so nothing was saved. Please try again.' },
      { status: 503 },
    ) }
  }
  if (check.refused.length > 0) {
    return { response: NextResponse.json({
      success: false,
      code: 'recipient_not_rate_viewer',
      error: `Staff cost reports can only go to owners and managers at this studio. Remove: ${check.refused.join(', ')}`,
      refused_recipients: check.refused,
    }, { status: 400 }) }
  }
  if (check.needsConfirmation.length > 0) {
    return { response: NextResponse.json({
      success: false,
      code: 'confirm_external_recipients',
      error: `These addresses are not staff at this studio: ${check.needsConfirmation.join(', ')}. Confirm they should receive staff cost figures.`,
      external_recipients: check.needsConfirmation,
    }, { status: 409 }) }
  }
  return { confirmedExternal: check.confirmedExternal }
}

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
    // REPORTS.2 — active=false is a DELETED schedule (DELETE deactivates).
    // A paused one stays listed.
    .eq('active', true)
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
    return NextResponse.json({ success: false, error: RATE_SCHEDULE_REFUSED }, { status: 403 })
  }
  if (body.deliver_notification === true) {
    return NextResponse.json({ success: false, error: NOTIFICATION_REFUSED }, { status: 400 })
  }

  const db = createServerClient()
  const deliverEmail = body.deliver_email || false
  const recipients = deliverEmail ? cleanRecipients(body.email_recipients) : []
  const recipientCheck = await checkRecipientsForSave({
    db, locationId, reportType: body.report_type, deliverEmail, recipients,
    previouslyConfirmed: [], confirmExternal: body.confirm_external,
  })
  if (recipientCheck.response) return recipientCheck.response

  const record = {
    location_id: locationId,
    created_by: user.id,
    report_type: body.report_type,
    report_name: body.report_name,
    frequency: body.frequency,
    day_of_week: body.day_of_week ?? null,
    day_of_month: body.day_of_month ?? null,
    deliver_email: deliverEmail,
    email_recipients: recipients,
    deliver_notification: false,
    confirmed_external_recipients: recipientCheck.confirmedExternal,
    parameters: body.parameters || {},
    active: true,
    paused: false,
  }

  // Calculate next_run_at using the shared helper
  record.next_run_at = calculateNextRun(record.frequency, record.day_of_week, record.day_of_month)

  const { data, error } = await db.from('scheduled_reports').insert(record).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data }, { status: 201 })
}

// PATCH /api/schedule/reports/scheduled?id=xxx — pause/resume or edit
export async function PATCH(request) {
  const user = await getCurrentUser()
  // Role is judged at the schedule's location below, never from user.role
  // (the ACTIVE studio's role).
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 })

  const validation = await validateBody(request, ScheduledReportPatchSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: existing, error: loadError } = await db.from('scheduled_reports')
    .select('id, location_id, report_type, frequency, day_of_week, day_of_month, deliver_email, email_recipients, confirmed_external_recipients, paused, active')
    .eq('id', id)
    .maybeSingle()
  if (loadError) return NextResponse.json({ success: false, error: loadError.message }, { status: 500 })
  // A deleted (deactivated) schedule is gone as far as editing goes.
  if (!existing || existing.active === false) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, existing.location_id)
  if (guard) return guard
  if (!canViewReportType(user, existing.location_id, existing.report_type, { hasRole: hasRoleAtLocation })) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const reportType = body.report_type ?? existing.report_type
  if (reportType !== existing.report_type
    && !canViewReportType(user, existing.location_id, reportType, { hasRole: hasRoleAtLocation })) {
    return NextResponse.json({ success: false, error: RATE_SCHEDULE_REFUSED }, { status: 403 })
  }
  if (body.deliver_notification === true) {
    return NextResponse.json({ success: false, error: NOTIFICATION_REFUSED }, { status: 400 })
  }

  const update = {}
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k)

  // Recipients are re-checked only when the save touches who receives what:
  // a plain pause must always work, even if a profile lookup is failing.
  const touchesDelivery = has('report_type') || has('deliver_email') || has('email_recipients')
  if (touchesDelivery) {
    const deliverEmail = has('deliver_email') ? body.deliver_email : existing.deliver_email === true
    const recipients = deliverEmail
      ? cleanRecipients(has('email_recipients') ? body.email_recipients : existing.email_recipients)
      : []
    const recipientCheck = await checkRecipientsForSave({
      db, locationId: existing.location_id, reportType, deliverEmail, recipients,
      previouslyConfirmed: existing.confirmed_external_recipients || [],
      confirmExternal: body.confirm_external,
    })
    if (recipientCheck.response) return recipientCheck.response
    update.report_type = reportType
    update.deliver_email = deliverEmail
    update.email_recipients = recipients
    update.confirmed_external_recipients = recipientCheck.confirmedExternal
  }
  if (has('report_name')) update.report_name = body.report_name
  if (has('deliver_notification')) update.deliver_notification = false

  const touchesTiming = has('frequency') || has('day_of_week') || has('day_of_month')
  const frequency = body.frequency ?? existing.frequency
  const dayOfWeek = has('day_of_week') ? body.day_of_week : existing.day_of_week
  const dayOfMonth = has('day_of_month') ? body.day_of_month : existing.day_of_month
  if (touchesTiming) {
    update.frequency = frequency
    update.day_of_week = dayOfWeek ?? null
    update.day_of_month = dayOfMonth ?? null
  }
  const resuming = body.paused === false && existing.paused === true
  if (has('paused')) update.paused = body.paused
  // A new timing, or a resume after next_run_at went by while paused, starts
  // from the next slot — never a catch-up run the moment it is resumed.
  if (touchesTiming || resuming) {
    update.next_run_at = calculateNextRun(frequency, dayOfWeek, dayOfMonth)
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ success: false, error: 'Nothing to change' }, { status: 400 })
  }
  update.updated_at = new Date().toISOString()

  const { data, error } = await db.from('scheduled_reports')
    .update(update)
    .eq('id', id)
    .select()
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  if (!data) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, data })
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
