// /api/schedule/rosters/[id]/approve — Roster v2 phase 5.
//
// An owner approves a draft roster that was created by a
// non-owner over the location's monthly contractor budget.
// Flips status='published', records the approval audit, tags
// blocks with the roster_id, sets shifts.published=true.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { notifyStaffOfPublish } from '@/lib/roster-notify'
import { logWarn } from '@/lib/log'

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const isMaster = user.role === 'master'
  const isOwnerSomewhere = (user.assignmentsByLocation || user.profileLocations || [])
    .some?.(l => (l.role || '') === 'owner')
  if (!isMaster && !isOwnerSomewhere && user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Only owners can approve rosters.' }, { status: 403 })
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

  // Per-location ownership check for non-master.
  if (!isMaster) {
    const userLocationIds = getUserLocationIds(user)
    if (!userLocationIds.includes(roster.location_id)) {
      return NextResponse.json({ success: false, error: 'Forbidden — not an owner at this location.' }, { status: 403 })
    }
    // Make sure the user is specifically OWNER at this location
    // (not just in_location). Phase 5 spec gates this on owner role.
    const role = user.rolesByLocation?.[roster.location_id]
    if (role !== 'owner') {
      return NextResponse.json({ success: false, error: 'Approval requires the owner role at this location.' }, { status: 403 })
    }
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

  // Tag blocks + flip legacy shifts.published.
  await db
    .from('shift_blocks')
    .update({ roster_id: roster.id })
    .eq('location_id', roster.location_id)
    .gte('block_date', roster.period_start)
    .lte('block_date', roster.period_end)

  // Capture the just-flipped shifts so we can fire staff
  // notifications (email + push) — same fan-out the normal
  // publish path uses. Without this, an owner-approved draft
  // would publish silently to staff.
  const { data: flippedShifts } = await db
    .from('shifts')
    .update({ published: true, published_at: nowIso })
    .eq('location_id', roster.location_id)
    .gte('shift_date', roster.period_start)
    .lte('shift_date', roster.period_end)
    .eq('published', false)
    .select('id, profile_id, location_id, shift_date')

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
