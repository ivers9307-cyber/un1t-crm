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
//   3. Notify the rostered coaches. (Publication derives from the
//      roster_id tag in step 2 → rosters.status; the old
//      public.shifts.published flag was dropped in mig 238.)
//
// GET: list rosters at a location. Used by the approvals queue
// and by retros.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, getUserLocationIds, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate, MANAGER_ROLES } from '@/lib/schemas'
import {
  projectPublishImpact,
  findConflictingPublishedRosters,
  releasePublishedRostersFor,
  restorePublishedRosters,
  supersedeSwallowedRosters,
  supersedeEmptyTrimmedRosters,
  suggestedCoveringPeriod,
  trimPublishedRosters,
  restoreRosterPeriods,
  publishAftermathNote,
  coversPeriod,
} from '@/lib/roster-publish'
import { sendOverBudgetApprovalEmail } from '@/lib/roster-email'
import { notifyStaffOfPublish, publishNotifyRowsForBlocks, renotifyChangedCoaches } from '@/lib/roster-notify'
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

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    // No specific location → scope to the caller's locations rather than
    // returning every location's rosters (incl. budgets). Service-role
    // bypasses RLS, so this fallback is the only thing filtering the read.
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, data: [] })
    query = query.in('location_id', userLocationIds)
  }
  // ROSTER-SUPERSEDE.1 — a superseded roster owns no blocks: it published
  // nothing that is still live, and it is kept only as the audit trail of a
  // publish event a later one took over. In the default list (the approvals
  // queue and the retro views) it reads as a duplicate publish over the same
  // dates, which is exactly the confusion superseding exists to remove. So it
  // is excluded by default and stays reachable with an explicit
  // ?status=superseded — hidden, never deleted, never unreachable.
  if (status) query = query.eq('status', status)
  else query = query.neq('status', 'superseded')

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // COACHSCOPE.1 — this list is open to anyone at the location, and it used to
  // hand a coach every roster's budget snapshot, contractor cost projection,
  // over-budget approver and the manager's notes, plus DRAFT rosters (D1: a
  // coach never learns a period is being drafted). Judged per row against the
  // caller's role at THAT roster's location (not `user.role`, the active
  // location's role): a manager row is untouched; a non-manager gets
  // published/superseded rows only, in the slim shape below.
  const shaped = (data || []).flatMap((r) => {
    if (hasRoleAtLocation(user, r.location_id, MANAGER_ROLES)) return [r]
    if (!COACH_VISIBLE_ROSTER_STATUSES.includes(r.status)) return []
    return [slimRosterForCoach(r)]
  })
  return NextResponse.json({ success: true, data: shaped })
}

const COACH_VISIBLE_ROSTER_STATUSES = ['published', 'superseded']

// Allow-list, not a delete-list: a budget/cost column added to `rosters` later
// stays manager-only until someone lists it here on purpose.
function slimRosterForCoach(r) {
  return {
    id: r.id,
    location_id: r.location_id,
    period_start: r.period_start,
    period_end: r.period_end,
    requested_period_start: r.requested_period_start,
    requested_period_end: r.requested_period_end,
    status: r.status,
    published_at: r.published_at,
    superseded_by: r.superseded_by,
    superseded_at: r.superseded_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    published_by_profile: r.published_by_profile
      ? { id: r.published_by_profile.id, full_name: r.published_by_profile.full_name }
      : null,
  }
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, PublishSchema)
  if (!validation.ok) return validation.response
  const { location_id, period_start, period_end, force_over_budget, dry_run, notes } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard

  // BUDGETAPPROVE.1 — every role decision on this route is made at the
  // ROSTER's location. `user.role` is the caller's role at their ACTIVE
  // studio, so an owner at Stillorgan who is head coach at Hatch read as an
  // owner while publishing Hatch, and could wave an over-budget Hatch roster
  // through on force_over_budget: a self-approval at a studio where they hold
  // no budget authority. The same misread let a manager elsewhere publish
  // here at all. Master bypass is `profileRole`, inside hasRoleAtLocation.
  if (!hasRoleAtLocation(user, location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  if (period_end < period_start) {
    return NextResponse.json({ success: false, error: 'period_end must be on or after period_start' }, { status: 400 })
  }

  const db = createServerClient()

  // ROSTER-FIX.4 — refuse a publish that would leave two published rosters
  // covering the same day at this location. The rule (and why an exact or a
  // containing period is still allowed) lives on the helper, which the
  // approve endpoint runs too — a guard only one publish path ran was no
  // guard at all.
  //
  // ROSTER-SUPERSEDE.1 — this is now only the STRADDLE guard. An exact or a
  // containing period is not just tolerated, it is resolved: the rosters this
  // period swallows are superseded below (released before the insert, stamped
  // with their successor after the re-tag), which is what lets mig 602's
  // exclusion constraint be applied at all.
  //
  // KNOWN GAP, still open and deliberately not fixed here: the swallowed
  // week's coaches are NOT re-notified by the wider publish. Both this route
  // and approve only notify blocks that were `roster_id IS NULL` before
  // tagging, and the swallowed week's blocks already carried the old roster's
  // id, so a month publish tells the coaches it just took over nothing at
  // all. The change-log path below covers the coaches whose shifts actually
  // CHANGED, which is the case that matters most; a re-notify of the rest is
  // a separate decision about how much noise a widening publish should make.
  //
  // ROSTER-TRIM.1 — and it is now only the TWO-SIDED straddle guard. A roster
  // that runs past ONE end of this period is trimmed back to the days it
  // keeps (below, before the insert) instead of refusing: that is how
  // "publish the boundary week, then publish the month" became possible at
  // all. The refusal that remains carries `suggested_period`, the smallest
  // period covering both, so the message can name a publish that works.
  const { conflicts, trimmable, overlapping, error: overlapErr } = await findConflictingPublishedRosters(db, {
    locationId: location_id,
    periodStart: period_start,
    periodEnd: period_end,
  })
  if (overlapErr) {
    return NextResponse.json({ success: false, error: overlapErr.message }, { status: 400 })
  }
  if (conflicts.length > 0) {
    return NextResponse.json({
      success: false,
      error: 'overlapping_roster',
      // The modal renders these ranges: "already published as part of
      // <range>", then the next step built from suggested_period.
      overlapping: conflicts,
      suggested_period: suggestedCoveringPeriod(conflicts, period_start, period_end),
    }, { status: 409 })
  }

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

  const isOwnerHere = hasRoleAtLocation(user, location_id, OWNER_ROLES)
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

  // ROSTER-SUPERSEDE.1 — phase 1, and it MUST be before the insert: mig 602's
  // exclusion constraint judges the INSERT, which happens before any block can
  // carry the new roster's id, so an exact re-publish would meet a raw 23P01
  // if we only superseded afterwards. Containment is exactly the set the guard
  // above lets through, so after this nothing published overlaps.
  //
  // Only for a real publish. A DRAFT owns no blocks until it is approved, so
  // superseding a live roster on its behalf would unpublish that period's
  // shifts for a draft that may never be approved.
  let released = []
  let trimmed = []
  let roster = null

  // ROSTER-SUPERSEDE.1 — ONE restore path for every way the write below can
  // fail, because a roster left superseded with no successor still owns its
  // blocks and every one of them reads as UNPUBLISHED to its coach until
  // somebody publishes the period again.
  async function restoreReleased(what) {
    if (released.length > 0) {
      const { error: restoreErr } = await restorePublishedRosters(db, released)
      if (restoreErr) {
        logWarn('rosters', `${what} AND the superseded rosters could not be restored`, {
          err: restoreErr.message,
          location_id,
          period_start,
          period_end,
          stranded: released.map((r) => r.id),
        })
      }
    }
    // ROSTER-TRIM.1 — a trimmed roster is the same class of damage one notch
    // smaller: it has given up days to a publish that never happened, and
    // every block on those days now reads as belonging to no live roster.
    if (trimmed.length > 0) {
      const { error: periodErr } = await restoreRosterPeriods(db, trimmed)
      if (periodErr) {
        logWarn('rosters', `${what} AND the trimmed rosters could not be put back`, {
          err: periodErr.message,
          location_id,
          period_start,
          period_end,
          stranded: trimmed.map((r) => r.id),
        })
      }
    }
  }

  // ROSTER-SUPERSEDE.1 — the release→insert span is wrapped because a THROWN
  // error (a PostgREST 5xx, a fetch failure, the function timing out) never
  // produces an error object, so the `insertErr` branch never runs and the
  // rosters stood down a moment ago would stay superseded FOREVER. A transient
  // blip silently unpublishing a coach's whole week is exactly the window this
  // work exists to close, so it is closed on both exits, not just the tidy one.
  try {
    if (status === 'published') {
      // ROSTER-TRIM.1 — trim the one-sided straddlers FIRST, for the same
      // reason the release runs before the insert: mig 602's exclusion
      // constraint judges the INSERT, and a roster still claiming a day
      // inside this period would meet it as a raw 23P01.
      const trim = await trimPublishedRosters(db, trimmable)
      if (trim.error) {
        return NextResponse.json({
          success: false,
          error: `Could not trim the rosters this publish overlaps: ${trim.error.message}`,
        }, { status: 400 })
      }
      trimmed = trim.trimmed

      const rel = await releasePublishedRostersFor(db, {
        locationId: location_id,
        periodStart: period_start,
        periodEnd: period_end,
      })
      if (rel.error) {
        // ROSTER-TRIM.1 — "nothing has changed yet" USED to be true here and
        // is not any more: the trim above has already written to disk. A
        // trimmed roster left behind by a publish that never happened owns
        // blocks OUTSIDE its own period — exactly the state mig 602's
        // pre-apply check (c2) requires to be empty — and phase 2's min/max
        // shrink would later widen its period back over another roster's
        // days. Put the trims (and anything already released) back before
        // refusing.
        await restoreReleased('standing down the rosters this publish replaces failed')
        return NextResponse.json({
          success: false,
          error: `Could not stand down the rosters this publish replaces: ${rel.error.message}`,
        }, { status: 400 })
      }
      released = rel.released
    }

    // Insert the roster row. status='draft' for needs-approval,
    // 'published' otherwise. published_by + published_at populated
    // up-front for self-publishes; for drafts, populated when the
    // owner approves.
    const insertPayload = {
      location_id,
      period_start,
      period_end,
      // ROSTER-SUPERSEDE.1 — the range the operator actually asked for, written
      // at insert time because nothing else ever can. period_* is shrunk to the
      // days this roster really owns (by mig 602's backfill and by
      // supersedeSwallowedRosters on every later publish); leaving these NULL
      // meant the first shrink rewrote the only record of the original ask,
      // which is the audit loss the columns were added to prevent.
      requested_period_start: period_start,
      requested_period_end: period_end,
      status,
      published_by: status === 'published' ? user.id : null,
      published_at: status === 'published' ? nowIso : null,
      over_budget_approval_by: status === 'published' && impact.overBudget ? user.id : null,
      over_budget_approval_at: status === 'published' && impact.overBudget ? nowIso : null,
      // BUDGETAPPROVE.1 — the WHOLE period's cost, every month it touches.
      projected_contractor_eur: impact.periodProjectedEur,
      budget_at_publish_eur: impact.monthlyBudgetEur,
      notes: notes || null,
      created_by: user.id,
    }

    const { data: inserted, error: insertErr } = await db
      .from('rosters')
      .insert(insertPayload)
      .select()
      .single()

    if (insertErr) {
      // ROSTER-SUPERSEDE.1 — the publish never happened, so put the released
      // rosters back.
      await restoreReleased('roster insert failed')
      return NextResponse.json({ success: false, error: insertErr.message }, { status: 400 })
    }
    roster = inserted
  } catch (e) {
    await restoreReleased('roster insert threw')
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }

  // ROSTER-SUPERSEDE.1 — surfaced on the response in the route's existing
  // partial-success shape rather than swallowed: the publish DID happen, but
  // an older roster may still be claiming days it owns no blocks on.
  let supersedeWarning = null
  // PUBLISH-CONFIRM.1 — what to tell the operator it actually did. The modal
  // used to close on success and show nothing at all, so a publish and a
  // no-op looked identical. Counts, not adjectives: shifts in the period, and
  // the coaches who were messaged about it.
  let coachesNotified = 0

  if (status === 'published') {
    // RETIRE-SHIFTS-MIRROR.6 — capture the blocks NEWLY being published
    // (roster_id IS NULL right now) BEFORE we tag them. Their assignments
    // are the "first publish" notify set — the new-model replacement for
    // the old `shifts.published false→true` capture. Blocks already
    // attached to an earlier roster are re-publishes, handled by the
    // change-log path below.
    // ROSTER-FIX.4 — a failed capture must not read as "nothing new": log it
    // and notify nobody from this set rather than pretend the publish had no
    // first-time blocks (the approve route does the same).
    const { data: newBlocks, error: captureErr } = await db
      .from('shift_blocks')
      .select('id')
      .eq('location_id', location_id)
      .gte('block_date', period_start)
      .lte('block_date', period_end)
      .is('roster_id', null)
    if (captureErr) logWarn('rosters', 'newly-published block capture failed', { err: captureErr.message })
    const newBlockIds = (newBlocks || []).map((b) => b.id)

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
      //
      // ROSTER-SUPERSEDE.1 — say the second half out loud. The rosters this
      // publish replaced are already superseded, and the blocks never moved
      // to the new one, so those shifts read as unpublished until the period
      // is published again. Restoring them is not on offer: the new roster is
      // published over the same days and the exclusion constraint would
      // refuse to put a second published roster back there.
      // ROSTER-TRIM.1 — stood-down and trimmed are DIFFERENT aftermaths and
      // one sentence for both was false for the trimmed half: a trimmed
      // roster is still published and its shifts still read published.
      // publishAftermathNote says each one only of the rosters it is true of.
      const stranded = publishAftermathNote({ releasedCount: released.length, trimmedCount: trimmed.length })
      // ROSTER-SUPERSEDE.1 — the HTTP response reaches whoever clicked
      // publish, and only them. Nobody watching the logs learns that a
      // location has a period reading as unpublished, so say it here too,
      // naming the rows a human has to re-publish.
      if (released.length + trimmed.length > 0) {
        // Two lists, never one: `stoodDown` is the set whose blocks now read
        // UNPUBLISHED (a human has to re-publish the period), `trimmedBack`
        // is the set still published whose period no longer matches the
        // blocks it owns. Merging them told whoever reads this log that live
        // shifts had vanished when they had not.
        logWarn('rosters', 'block tagging failed after the replaced rosters were settled', {
          err: tagErr.message,
          location_id,
          period_start,
          period_end,
          roster_id: roster.id,
          stoodDown: released.map((r) => r.id),
          trimmedBack: trimmed.map((r) => r.id),
        })
      }
      return NextResponse.json({
        success: true,
        data: roster,
        warning: `Roster published but block tagging failed: ${tagErr.message}.${stranded}`,
      }, { status: 201 })
    }

    // ROSTER-SUPERSEDE.1 — phase 2, and it has to be AFTER the re-tag above:
    // the recount inside reads the new roster as owning nothing until its
    // blocks carry its id. The helper excludes roster.id explicitly too.
    const swallow = await supersedeSwallowedRosters(db, {
      locationId: location_id,
      newRosterId: roster.id,
      periodStart: period_start,
      periodEnd: period_end,
      releasedIds: released.map((r) => r.id),
    })
    if (swallow.warning) {
      logWarn('rosters', 'supersede of swallowed rosters incomplete', { err: swallow.warning, roster_id: roster.id })
      supersedeWarning = swallow.warning
    }

    // ROSTERTIDY.1 — a trimmed remnant left owning NO blocks is superseded
    // now, after the re-tag (before it, the remnant still owns the blocks this
    // publish takes). The sweep above never sees it: after the trim it no
    // longer overlaps this period. Log-only on failure, deliberately NOT added
    // to supersedeWarning — the remnant is harmless as data, and the operator
    // has nothing to act on.
    if (trimmed.length > 0) {
      const remnants = await supersedeEmptyTrimmedRosters(db, { newRosterId: roster.id, trimmed })
      if (remnants.warning) {
        logWarn('rosters', 'empty trimmed roster could not be superseded', { err: remnants.warning, roster_id: roster.id })
      }
    }

    // Coaches assigned to the newly-published blocks.
    const flippedShifts = await publishNotifyRowsForBlocks(db, newBlockIds)

    // SCHEDULE-NOTIFY.1 — notify each coach their roster is live (one
    // push per coach, summarising their shifts for the period). Reuses
    // the same notifyStaffOfPublish() the approval path also uses.
    // Best-effort; never fails the publish.
    try {
      const notified = await notifyStaffOfPublish(db, flippedShifts || [], {
        startDate: period_start,
        endDate: period_end,
        locationId: location_id,
      })
      coachesNotified += notified?.notified || 0
    } catch (e) {
      logWarn('rosters', 'publish notify failed', { err: e })
    }

    // SCHEDULE-CHANGE-LOG.1 / NOTIFY.1 — re-notify coaches whose published
    // shifts changed and were not already told at the moment of change.
    const renotified = await renotifyChangedCoaches(db, { locationId: location_id, periodStart: period_start, periodEnd: period_end })
    coachesNotified += renotified?.notified || 0
  } else {
    // status === 'draft' — manager publish over budget. Email
    // owners so they can approve. Best-effort; don't fail the
    // request if the email send chokes.
    try {
      // OVERBUDGET-COPY.1 — the email used to state flatly that staff cannot
      // see their shifts until an owner approves. That is only true of a
      // period nobody has published yet. Re-publishing a week that is already
      // live leaves every shift on it exactly as visible as it was, and the
      // draft holds back the CHANGES, not the roster. `overlapping` is the
      // set of published rosters this period already touches (the guard above
      // read it), so the wording can tell the truth in all three shapes.
      await sendOverBudgetApprovalEmail(db, {
        rosterId: roster.id,
        locationId: location_id,
        publisherName: user.fullName || user.email,
        periodStart: period_start,
        periodEnd: period_end,
        overrunEur: impact.overrunEur,
        budgetEur: impact.monthlyBudgetEur,
        months: impact.months,
        alreadyPublished: overlapping.length > 0,
        fullyPublished: coversPeriod(overlapping, period_start, period_end),
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
    // PUBLISH-CONFIRM.1 — the success state the modal renders. `blockCount`
    // is every shift in the period (projectPublishImpact counts them all, not
    // only the ones carrying contractor cost); `coaches_notified` is coaches
    // TARGETED, first-publish plus change re-notify, never a delivery proof.
    ...(status === 'published'
      ? { published_summary: { shift_count: impact.blockCount, coaches_notified: coachesNotified } }
      : {}),
    ...(supersedeWarning ? { warning: `Roster published, but standing down the rosters it replaces did not fully complete: ${supersedeWarning}` } : {}),
  }, { status: status === 'draft' ? 202 : 201 })
}
