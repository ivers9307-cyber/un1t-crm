// /api/schedule/rosters — Roster v2 phase 5.
//
// POST: publish a roster for a (location, period). Behaviour
// branches on whether the publish would push the calendar
// month's contractor labour cost over the location's monthly
// budget AND the user's role:
//
//   under budget                 → publish, return success
//   over + caller is owner+master with force=true
//                                → publish, record self-approval
//   over + caller is owner+master without force
//                                → 409 with budget breakdown for
//                                  the modal to confirm + retry
//   over + caller is manager     → create draft (status='draft'),
//                                  email owners, return 202
//
// "Publish" means:
//   1. Insert a `rosters` row capturing who/when/budget snapshot.
//   2. Tag every block in the period with roster_id.
//   3. Set the legacy public.shifts.published=true so mobile +
//      reports see the roster as live.
//
// GET: list rosters at a location. Used by the approvals queue
// and by retros.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate, MANAGER_ROLES } from '@/lib/schemas'
import { projectPublishImpact } from '@/lib/roster-publish'
import { sendOverBudgetApprovalEmail } from '@/lib/roster-email'
import { logWarn } from '@/lib/log'

const PublishSchema = z.object({
  location_id: uuidLike,
  period_start: isoDate,
  period_end: isoDate,
  // Set true on a retry to acknowledge the over-budget warning.
  // Only honoured if the caller is owner-at-this-location or master.
  force_over_budget: z.boolean().optional(),
  // dry_run=true returns the budget projection WITHOUT creating a
  // roster. Used by the publish modal to show the impact preview.
  dry_run: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
})

const OWNER_ROLES = ['owner']

// GET /api/schedule/rosters?location_id=...&status=draft
export async function GET(request) {
  const user = await getCurrentUser()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const status = searchParams.get('status')

  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  let query = db
    .from('rosters')
    .select(`
      *,
      published_by_profile:published_by(id, full_name, email),
      over_budget_approval_by_profile:over_budget_approval_by(id, full_name)
    `)
    .order('created_at', { ascending: false })

  if (locationId) query = query.eq('location_id', locationId)
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, PublishSchema)
  if (!validation.ok) return validation.response
  const { location_id, period_start, period_end, force_over_budget, dry_run, notes } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard

  if (period_end < period_start) {
    return NextResponse.json({ success: false, error: 'period_end must be on or after period_start' }, { status: 400 })
  }

  const db = createServerClient()

  // Compute the budget projection. This is also what the modal
  // shows the operator before they commit.
  let impact
  try {
    impact = await projectPublishImpact(db, {
      locationId: location_id,
      periodStart: period_start,
      periodEnd: period_end,
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }

  const isOwnerHere = user.role === 'master' || OWNER_ROLES.includes(user.role)
  const needsApproval = impact.overBudget && !isOwnerHere
  const ownerMustConfirm = impact.overBudget && isOwnerHere && !force_over_budget

  // dry_run = preview only. Return impact + role-aware decision
  // hint without creating a roster.
  if (dry_run) {
    return NextResponse.json({
      success: true,
      dry_run: true,
      impact,
      can_publish: !needsApproval,           // false → manager + over budget
      requires_owner_confirmation: ownerMustConfirm,
    })
  }

  // Owner attempted publish over budget without force flag — surface
  // the breakdown so the modal can show "you'll be €X over, confirm?".
  if (ownerMustConfirm) {
    return NextResponse.json({
      success: false,
      error: 'over_budget_confirmation_required',
      impact,
    }, { status: 409 })
  }

  const status = needsApproval ? 'draft' : 'published'
  const nowIso = new Date().toISOString()

  // Insert the roster row. status='draft' for needs-approval,
  // 'published' otherwise. published_by + published_at populated
  // up-front for self-publishes; for drafts, populated when the
  // owner approves.
  const insertPayload = {
    location_id,
    period_start,
    period_end,
    status,
    published_by: status === 'published' ? user.id : null,
    published_at: status === 'published' ? nowIso : null,
    over_budget_approval_by: status === 'published' && impact.overBudget ? user.id : null,
    over_budget_approval_at: status === 'published' && impact.overBudget ? nowIso : null,
    projected_contractor_eur: impact.periodProjectedEur,
    budget_at_publish_eur: impact.monthlyBudgetEur,
    notes: notes || null,
    created_by: user.id,
  }

  const { data: roster, error: insertErr } = await db
    .from('rosters')
    .insert(insertPayload)
    .select()
    .single()

  if (insertErr) {
    return NextResponse.json({ success: false, error: insertErr.message }, { status: 400 })
  }

  if (status === 'published') {
    // Tag the blocks in the period with this roster.
    const { error: tagErr } = await db
      .from('shift_blocks')
      .update({ roster_id: roster.id })
      .eq('location_id', location_id)
      .gte('block_date', period_start)
      .lte('block_date', period_end)
    if (tagErr) {
      // Roster row already in place — let the operator see it as
      // a partial success rather than rolling back the whole thing.
      return NextResponse.json({
        success: true,
        data: roster,
        warning: `Roster published but block tagging failed: ${tagErr.message}`,
      }, { status: 201 })
    }

    // Flip legacy shifts.published=true so mobile + reports
    // continue to see the roster as live. The mig 069 reverse
    // trigger doesn't propagate the published flag, so we set
    // it directly here. We don't go through the legacy
    // /api/schedule/shifts/publish endpoint to avoid double
    // notifications.
    await db.from('shifts')
      .update({ published: true, published_at: nowIso })
      .eq('location_id', location_id)
      .gte('shift_date', period_start)
      .lte('shift_date', period_end)
      .eq('published', false)
  } else {
    // status === 'draft' — manager publish over budget. Email
    // owners so they can approve. Best-effort; don't fail the
    // request if the email send chokes.
    try {
      await sendOverBudgetApprovalEmail(db, {
        rosterId: roster.id,
        locationId: location_id,
        publisherName: user.fullName || user.email,
        periodStart: period_start,
        periodEnd: period_end,
        overrunEur: impact.overrunEur,
        budgetEur: impact.monthlyBudgetEur,
      })
    } catch (e) {
      logWarn('rosters', `approval email failed`, { err: e })
    }
  }

  return NextResponse.json({
    success: true,
    data: roster,
    impact,
    needs_approval: status === 'draft',
  }, { status: status === 'draft' ? 202 : 201 })
}
