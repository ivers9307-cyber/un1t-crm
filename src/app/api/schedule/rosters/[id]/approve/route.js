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
//
// BUDGETAPPROVE.1 — approving re-runs the budget projection. The draft's
// stored figures were a snapshot from the moment the manager hit publish, and
// drafts have waited up to 218 hours in the queue; approval used to stamp the
// sign-off against that stale number. The approver IS the budget authority,
// so a changed number never refuses the approval: the fresh figures are
// written onto the roster and returned, with `projection_changed` and both
// figures, so the approver sees what they actually signed.
//
// The approver's authority resolves at the ROSTER's location
// (hasPermissionForLocation below), never the caller's active studio.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { notifyStaffOfPublish, publishNotifyRowsForBlocks, renotifyChangedCoaches } from '@/lib/roster-notify'
import {
  projectPublishImpact,
  projectionChanged,
  findConflictingPublishedRosters,
  releasePublishedRostersFor,
  restorePublishedRosters,
  supersedeSwallowedRosters,
  suggestedCoveringPeriod,
  trimPublishedRosters,
  restoreRosterPeriods,
  publishAftermathNote,
} from '@/lib/roster-publish'
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
  //
  // ROSTER-TRIM.1 — a one-sided straddle is trimmed rather than refused here
  // too: approving IS publishing, and a guard only one of the two paths ran
  // was never a guard.
  const { conflicts, trimmable, error: overlapErr } = await findConflictingPublishedRosters(db, {
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
      suggested_period: suggestedCoveringPeriod(conflicts, roster.period_start, roster.period_end),
    }, { status: 409 })
  }

  // BUDGETAPPROVE.1 — re-project against live data before the flip. A failed
  // projection does NOT block the approval (the approver is the budget
  // authority and approving on the stored snapshot is exactly what happened
  // before this change); it is logged, the stored figures are left alone, and
  // the response says the numbers could not be refreshed.
  let impact = null
  let projectionError = null
  try {
    impact = await projectPublishImpact(db, {
      locationId: roster.location_id,
      periodStart: roster.period_start,
      periodEnd: roster.period_end,
    })
  } catch (e) {
    projectionError = e?.message || String(e)
    logWarn('rosters/approve', 'budget re-projection failed; approving on the stored figures', {
      err: projectionError,
      roster_id: roster.id,
    })
  }
  const storedProjection = {
    projected_contractor_eur: roster.projected_contractor_eur == null ? null : Number(roster.projected_contractor_eur),
    budget_at_publish_eur: roster.budget_at_publish_eur == null ? null : Number(roster.budget_at_publish_eur),
  }
  const freshProjection = impact
    ? { projected_contractor_eur: impact.periodProjectedEur, budget_at_publish_eur: impact.monthlyBudgetEur }
    : null
  const changed = projectionChanged(roster, impact)

  const nowIso = new Date().toISOString()

  // ROSTER-SUPERSEDE.1 — phase 1, before the flip. Approving is a publish, and
  // mig 602's exclusion constraint judges the draft→published UPDATE exactly
  // as it judges an INSERT, so the rosters this period swallows have to be
  // stood down first. excludeRosterId keeps this draft out of its own release
  // set (it is not published, so it would not be selected anyway — the
  // exclusion says so rather than relying on that).
  let released = []
  let trimmed = []
  let updated = null

  // ROSTER-SUPERSEDE.1 — ONE restore path for every way the flip can fail:
  // superseded with no successor, the released rosters still own their blocks
  // and every one would read as UNPUBLISHED to its coach.
  async function restoreReleased(what) {
    if (released.length > 0) {
      const { error: restoreErr } = await restorePublishedRosters(db, released)
      if (restoreErr) {
        logWarn('rosters/approve', `${what} AND the superseded rosters could not be restored`, {
          err: restoreErr.message,
          location_id: roster.location_id,
          period_start: roster.period_start,
          period_end: roster.period_end,
          stranded: released.map((r) => r.id),
        })
      }
    }
    // ROSTER-TRIM.1 — a trimmed roster gave days away to an approval that
    // never happened; put its period back or those blocks belong to no live
    // roster.
    if (trimmed.length > 0) {
      const { error: periodErr } = await restoreRosterPeriods(db, trimmed)
      if (periodErr) {
        logWarn('rosters/approve', `${what} AND the trimmed rosters could not be put back`, {
          err: periodErr.message,
          location_id: roster.location_id,
          period_start: roster.period_start,
          period_end: roster.period_end,
          stranded: trimmed.map((r) => r.id),
        })
      }
    }
  }

  // ROSTER-SUPERSEDE.1 — the release→flip span is wrapped because a THROWN
  // error (a PostgREST 5xx, a fetch failure, the function timing out) never
  // produces an error object, so the `updErr` branch never runs and the
  // rosters stood down a moment ago would stay superseded FOREVER: a transient
  // blip would silently unpublish a coach's whole week.
  try {
    // ROSTER-TRIM.1 — trim before the flip, for the same reason the release
    // runs before it: mig 602's exclusion constraint judges the
    // draft to published UPDATE exactly as it judges an INSERT.
    const trim = await trimPublishedRosters(db, trimmable)
    if (trim.error) {
      return NextResponse.json({
        success: false,
        error: `Could not trim the rosters this approval overlaps: ${trim.error.message}`,
      }, { status: 400 })
    }
    trimmed = trim.trimmed

    const rel = await releasePublishedRostersFor(db, {
      locationId: roster.location_id,
      periodStart: roster.period_start,
      periodEnd: roster.period_end,
      excludeRosterId: roster.id,
    })
    if (rel.error) {
      // ROSTER-TRIM.1 — the trim above has already written to disk, so this
      // is no longer the free refusal it was: a trimmed roster stranded by an
      // approval that never happened owns blocks outside its own period (mig
      // 602's check (c2)), and phase 2 would later widen it back over another
      // roster's days.
      await restoreReleased('standing down the rosters this approval replaces failed')
      return NextResponse.json({
        success: false,
        error: `Could not stand down the rosters this approval replaces: ${rel.error.message}`,
      }, { status: 400 })
    }
    released = rel.released

    // ROSTER-SUPERSEDE.1 — a flip, not an insert: this row already carries the
    // requested_period_* the publish route wrote when the draft was created,
    // and approving does not change what was asked for, so there is nothing to
    // preserve here.
    const { data: flipped, error: updErr } = await db
      .from('rosters')
      .update({
        status: 'published',
        published_by: roster.published_by || roster.created_by,
        published_at: nowIso,
        over_budget_approval_by: user.id,
        over_budget_approval_at: nowIso,
        // BUDGETAPPROVE.1 — the figures the approval was actually given on.
        ...(freshProjection || {}),
      })
      .eq('id', params.id)
      .select()
      .single()
    if (updErr) {
      // The approval never happened, so put the released rosters back.
      await restoreReleased('approval failed')
      return NextResponse.json({ success: false, error: updErr.message }, { status: 400 })
    }
    updated = flipped
  } catch (e) {
    await restoreReleased('approval threw')
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }

  // BUDGETAPPROVE.1 — carried on every success response, partial or not.
  const projectionBody = {
    impact,
    projection_changed: changed,
    ...(changed ? { previous_projection: storedProjection, current_projection: freshProjection } : {}),
    ...(projectionError ? { projection_error: projectionError } : {}),
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
    //
    // ROSTER-SUPERSEDE.1 — and the rosters this approval replaced are already
    // stood down, so their shifts read as unpublished until the period is
    // published again. Restoring them is not on offer either: this roster is
    // published over the same days and the constraint would refuse a second.
    // ROSTER-TRIM.1 — stood-down and trimmed are different aftermaths; see
    // publishAftermathNote. A trimmed roster stays published and its shifts
    // still read published, so it must not be described as lost.
    const stranded = publishAftermathNote({ releasedCount: released.length, trimmedCount: trimmed.length })
    // ROSTER-SUPERSEDE.1 — the HTTP response reaches whoever clicked approve,
    // and only them. Nobody watching the logs learns that a location has a
    // period reading as unpublished, so say it here too, naming the rows a
    // human has to re-publish.
    if (released.length + trimmed.length > 0) {
      // Two lists, never one: only `stoodDown` has blocks reading unpublished.
      logWarn('rosters/approve', 'block tagging failed after the replaced rosters were settled', {
        err: tagErr.message,
        location_id: roster.location_id,
        period_start: roster.period_start,
        period_end: roster.period_end,
        roster_id: roster.id,
        stoodDown: released.map((r) => r.id),
        trimmedBack: trimmed.map((r) => r.id),
      })
    }
    return NextResponse.json({
      success: true,
      data: updated,
      ...projectionBody,
      warning: `Roster approved but block tagging failed: ${tagErr.message}.${stranded}`,
    })
  }

  // ROSTER-SUPERSEDE.1 — phase 2, AFTER the re-tag: the recount inside reads
  // this roster as owning nothing until its blocks carry its id, and it would
  // otherwise supersede itself. The helper excludes it explicitly too.
  const swallow = await supersedeSwallowedRosters(db, {
    locationId: roster.location_id,
    newRosterId: roster.id,
    periodStart: roster.period_start,
    periodEnd: roster.period_end,
    releasedIds: released.map((r) => r.id),
  })
  if (swallow.warning) {
    logWarn('rosters/approve', 'supersede of swallowed rosters incomplete', { err: swallow.warning, roster_id: roster.id })
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

  // NOTIFY.1 — approving a draft that re-publishes a live week used to skip
  // this entirely: 37 changes covered only by approved drafts were never sent.
  await renotifyChangedCoaches(db, {
    locationId: roster.location_id,
    periodStart: roster.period_start,
    periodEnd: roster.period_end,
  })

  return NextResponse.json({
    success: true,
    data: updated,
    ...projectionBody,
    // ROSTER-SUPERSEDE.1 — surfaced, not swallowed: the approval DID happen,
    // but an older roster may still be claiming days it owns no blocks on.
    ...(swallow.warning ? { warning: `Roster approved, but standing down the rosters it replaces did not fully complete: ${swallow.warning}` } : {}),
  })
}
