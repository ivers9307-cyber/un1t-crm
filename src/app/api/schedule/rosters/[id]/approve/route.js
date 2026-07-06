// /api/schedule/rosters/[id]/approve — Roster v2 phase 5.
//
// An owner approves a draft roster that was created by a
// non-owner over the location's monthly contractor budget.
// Flips status='published', records the approval audit, tags
// blocks with the roster_id, and notifies the rostered coaches.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { notifyStaffOfPublish, publishNotifyRowsForBlocks } from '@/lib/roster-notify'
import { logWarn } from '@/lib/log'
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()

  const { data: roster, error: fetchErr } = await db
    .from('rosters')
    .select('*')
    .eq('id', params.id)
    .single()
  if (fetchErr || !roster) {
    return NextResponse.json({ success: false, error: 'Roster not found' }, { status: 404 })
  }

  if (roster.status !== 'draft') {
    return NextResponse.json({
      success: false,
      error: `Roster is already ${roster.status}; only draft rosters can be approved.`,
    }, { status: 409 })
  }

  // APPROVALS-PERCAT.1 — permission is the only gate (roster.location_id
  // resolved after the roster row loaded above).
  if (!hasPermissionForLocation(user, roster.location_id, APPROVAL_CATEGORY_PERMISSION.rosters)) {
    return NextResponse.json({ success: false, error: 'You do not have permission to approve rosters.' }, { status: 403 })
  }

  const nowIso = new Date().toISOString()

  const { data: updated, error: updErr } = await db
    .from('rosters')
    .update({
      status: 'published',
      published_by: roster.published_by || roster.created_by,
      published_at: nowIso,
      over_budget_approval_by: user.id,
      over_budget_approval_at: nowIso,
    })
    .eq('id', params.id)
    .select()
    .single()
  if (updErr) {
    return NextResponse.json({ success: false, error: updErr.message }, { status: 400 })
  }

  // RETIRE-SHIFTS-MIRROR.6 — capture the blocks NEWLY being published
  // (roster_id IS NULL) BEFORE tagging; their assignments are the notify
  // set (new-model replacement for the old shifts.published flip).
  const { data: newBlocks } = await db
    .from('shift_blocks')
    .select('id')
    .eq('location_id', roster.location_id)
    .gte('block_date', roster.period_start)
    .lte('block_date', roster.period_end)
    .is('roster_id', null)
  const newBlockIds = (newBlocks || []).map((b) => b.id)

  // Tag blocks with the roster.
  await db
    .from('shift_blocks')
    .update({ roster_id: roster.id })
    .eq('location_id', roster.location_id)
    .gte('block_date', roster.period_start)
    .lte('block_date', roster.period_end)

  // Coaches on the newly-published blocks. Without this, an owner-approved
  // draft would publish silently to staff.
  const flippedShifts = await publishNotifyRowsForBlocks(db, newBlockIds)

  // Best-effort notify — wrapped so a Postmark/push hiccup
  // doesn't roll back the approval.
  try {
    await notifyStaffOfPublish(db, flippedShifts || [], {
      startDate: roster.period_start,
      endDate: roster.period_end,
      locationId: roster.location_id,
    })
  } catch (e) {
    logWarn('rosters/approve', `staff notify failed`, { err: e })
  }

  return NextResponse.json({ success: true, data: updated })
}
