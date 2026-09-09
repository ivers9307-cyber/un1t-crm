// /api/schedule/rosters/[id]/approve — Roster v2 phase 5.
//
// An owner approves a draft roster that was created by a
// non-owner over the location's monthly contractor budget.
// Flips status='published', records the approval audit, tags
// blocks with the roster_id, and notifies the rostered coaches.
//
// ROSTER-FIX.4 — approving IS publishing, so it runs the same overlap guard
// POST /api/schedule/rosters runs. A draft can sit in the queue for days
// while somebody else publishes a roster over the same dates; approving it
// then would have created exactly the two-published-rosters-one-day state
// the POST guard exists to prevent.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { notifyStaffOfPublish, publishNotifyRowsForBlocks } from '@/lib/roster-notify'
import { findConflictingPublishedRosters } from '@/lib/roster-publish'
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

  // ROSTER-FIX.4 — cross-tenant posture BEFORE the permission check. This is
  // a detail route on a service-role client (RLS bypassed), so a roster at a
  // location the caller isn't assigned to must be indistinguishable from one
  // that doesn't exist: 403 there would confirm the id is real and name a
  // location the caller can't see. A caller AT the location who simply lacks
  // the rosters permission still gets the 403 below — that answers "may you",
  // not "does it exist".
  if (user.role !== 'master' && !getUserLocationIds(user).includes(roster.location_id)) {
    return NextResponse.json({ success: false, error: 'Roster not found' }, { status: 404 })
  }

  // APPROVALS-PERCAT.1 — permission is the only gate (roster.location_id
  // resolved after the roster row loaded above).
  //
  // ROSTER-FIX.4 — checked BEFORE the status branch (reject already does).
  // Below it, a caller with no rosters permission got a 409 naming the
  // roster's status and a 403 otherwise, which turned the endpoint into an
  // oracle for which ids are drafts awaiting approval.
  if (!hasPermissionForLocation(user, roster.location_id, APPROVAL_CATEGORY_PERMISSION.rosters)) {
    return NextResponse.json({ success: false, error: 'You do not have permission to approve rosters.' }, { status: 403 })
  }

  if (roster.status !== 'draft') {
    return NextResponse.json({
      success: false,
      error: `Roster is already ${roster.status}; only draft rosters can be approved.`,
    }, { status: 409 })
  }

  // ROSTER-FIX.4 — same guard, same 409 shape, as the publish route. Exclude
  // this roster's own id: it is a draft today, but the exclusion keeps the
  // check honest if a caller ever re-runs it against a published row.
  const { conflicts, error: overlapErr } = await findConflictingPublishedRosters(db, {
    locationId: roster.location_id,
    periodStart: roster.period_start,
    periodEnd: roster.period_end,
    excludeRosterId: roster.id,
  })
  if (overlapErr) {
    return NextResponse.json({ success: false, error: overlapErr.message }, { status: 400 })
  }
  if (conflicts.length > 0) {
    return NextResponse.json({
      success: false,
      error: 'overlapping_roster',
      overlapping: conflicts,
    }, { status: 409 })
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
  const { data: newBlocks, error: captureErr } = await db
    .from('shift_blocks')
    .select('id')
    .eq('location_id', roster.location_id)
    .gte('block_date', roster.period_start)
    .lte('block_date', roster.period_end)
    .is('roster_id', null)
  if (captureErr) {
    // ROSTER-FIX.4 — this read only decides WHO gets notified, so losing it
    // must not undo an approval that already happened. It was discarded
    // entirely before: the roster went live, `newBlocks` fell back to `[]`,
    // and not one coach was told, with nothing in the log to say why.
    logWarn('rosters/approve', 'newly-published block capture failed; no coach will be notified', {
      err: captureErr.message,
      roster_id: roster.id,
    })
  }
  const newBlockIds = (newBlocks || []).map((b) => b.id)

  // Tag blocks with the roster.
  const { error: tagErr } = await db
    .from('shift_blocks')
    .update({ roster_id: roster.id })
    .eq('location_id', roster.location_id)
    .gte('block_date', roster.period_start)
    .lte('block_date', roster.period_end)
  if (tagErr) {
    // ROSTER-FIX.4 — same partial-success shape POST /api/schedule/rosters
    // returns. The roster row is already published, so rolling back isn't on
    // offer; the operator needs to know the blocks didn't join it (untagged
    // blocks read as belonging to no roster) rather than see a bare success.
    return NextResponse.json({
      success: true,
      data: updated,
      warning: `Roster approved but block tagging failed: ${tagErr.message}`,
    })
  }

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
