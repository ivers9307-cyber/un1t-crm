// /api/schedule/blocks/[id] — DELETE, PUT
//
// Removes a shift_block. Cascades to shift_assignments via the FK
// on delete. (The old public.shifts mirror that the mig 068 trigger
// kept in sync was dropped in mig 238.)
//
// SCHEDROLES.1 — authority is the caller's role at the BLOCK's location
// (hasRoleAtLocation), not `user.role` (the ACTIVE studio's role). A head
// coach at Hatch who is staff at Stillorgan could delete Stillorgan slots
// from a Hatch session; and a manager whose active studio is one where they
// are staff was refused at their own. The pre-check is only "manages
// somewhere".
//
// Only used for one-off "this slot doesn't apply this week"
// removals. The default lifecycle is template days_of_week →
// auto-generated blocks; deleting a block here doesn't change the
// template.
//
// SLOTNOTIFY.1 — deleting a STAFFED slot takes its shift_assignments with it
// through the mig 067 FK cascade. On a published roster that is coaches losing
// a shift, and it told nobody: no roster_change_log row (so the re-publish
// safety net had nothing to find either) and no message. It now writes the
// same `unassigned` rows and sends the same notification as
// DELETE /api/schedule/assignments/[id], through the helper they share
// (logAndNotifyUnassignments), so the stamping rules cannot drift apart.
// Because the cascade destroys the very rows that say WHO to tell, the
// assignments are read BEFORE the delete and an unreadable read refuses the
// delete — the one place here where failing closed costs a retry rather than a
// coach's notification.
//
// SLOTREMOVAL.1 — it used to be that the next regeneration recreated the
// slot (the nightly horizon upserts every date the template runs), so a
// deleted slot was back by morning. The delete now also writes a
// shift_block_removals row (mig 613) for (location, template, date), which
// the generator and both roster copy modes skip. Creating the block again
// by hand (POST /api/schedule/blocks) deletes that row — the undo. To stop a
// slot on EVERY week, deactivate the template instead.
//
// BLOCKEDIT.1 — PUT edits ONE shift: start/end time, min/max coaches and the
// coach-visible briefing (mig 629). The rules are in src/lib/block-edit.js
// (planBlockEdit). Same gate as DELETE: manager AT the block's studio, 404
// outside the caller's studios. On a PUBLISHED roster every edit writes a
// coachless `block_edited` change-log row, and each coach whose own hours moved
// gets a `time_changed` row that the */5 notice arm (src/lib/block-edit-notify.js)
// turns into ONE message inside quiet hours. The route itself sends nothing.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { MANAGER_ROLES, timeOfDay, uuidLike } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'
import { isLiveAssignment } from '@/lib/roster'
import { logAndNotifyUnassignments } from '@/lib/shift-unassign'
import { logRosterChange, logBlockEdit, markChangesNotified } from '@/lib/roster-change-log'
import { planBlockEdit, sameWindow, matchesExpected, blockEditNoticeWhen, TIME_CHANGE_SOURCE } from '@/lib/block-edit'
import { dublinTodayStr } from '@/lib/dublin-time'
import { BRIEFING_MAX_LENGTH } from '@shared/shift-briefing'
import { findShiftOverlaps } from '@/lib/shift-overlaps'
import { logWarn } from '@/lib/log'

export async function DELETE(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()

  // Fetch the block first: its location decides the caller's authority.
  const { data: block, error: fetchErr } = await db
    .from('shift_blocks')
    // SLOTNOTIFY.1 — the roster status decides whether the coaches on this
    // block are losing a shift they have already been told about.
    .select('id, location_id, template_id, block_date, roster_id, rosters:roster_id(status)')
    .eq('id', params.id)
    .single()

  if (fetchErr || !block) {
    return NextResponse.json({ success: false, error: 'Block not found' }, { status: 404 })
  }

  // An outsider to the block's studio gets 404 (detail route: the id is not
  // confirmed); a member without a manager role there gets 403.
  const notHere = assertLocationAccessOr404(user, block.location_id)
  if (notHere) return notHere
  if (!hasRoleAtLocation(user, block.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // SLOTNOTIFY.1 — who is on this slot, read while the rows still exist. Only
  // a published roster needs the answer: on a draft there is nothing to log
  // (logRosterChange no-ops) and nothing to tell anyone, so a draft delete
  // behaves exactly as it always has and never pays for this read.
  const isPublished = block.rosters?.status === 'published'
  let affected = []
  if (isPublished) {
    const { data: assignments, error: assignErr } = await db
      .from('shift_assignments')
      .select('id, profile_id, status')
      .eq('block_id', params.id)
    if (assignErr) {
      // Refuse BEFORE anything is destroyed. This is the rare case where
      // failing closed is right: the delete would cascade away the only record
      // of who was on the slot, so proceeding trades a retry the manager can
      // make for a notification nobody can ever reconstruct.
      logWarn('schedule-blocks', 'could not read the slot’s assignments; refusing the delete', {
        blockId: block.id, locationId: block.location_id, err: assignErr,
      })
      return NextResponse.json({
        success: false,
        error: 'Could not check who is on this slot, so it was not deleted. Try again.',
        transient: true,
      }, { status: 503 })
    }
    // A cancelled assignment is not on the roster (isLiveAssignment) — the
    // same filter publishNotifyRowsForBlocks applies, so a publish and a
    // deletion never disagree about who counts as rostered.
    affected = (assignments || []).filter(isLiveAssignment).map((a) => ({
      id: a.id,
      profile_id: a.profile_id,
      block_id: block.id,
      block_date: block.block_date,
      location_id: block.location_id,
      roster_status: 'published',
      details: { via: 'slot_deleted' },
    }))
  }

  const { error } = await db.from('shift_blocks').delete().eq('id', params.id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // SLOTNOTIFY.1 — the assignments went with the block. Log + notify exactly
  // as the assignment DELETE path does, and BEFORE the slot-removal record
  // below, whose failure returns early: a lost tombstone must never cost the
  // coaches their message. Best-effort inside the helper; it never throws.
  if (affected.length > 0) {
    await logAndNotifyUnassignments(db, { actorId: user.id, assignments: affected })
  }

  // SLOTREMOVAL.1 — remember the removal so the nightly generator and roster
  // copies don't bring the slot back. Written AFTER the delete: a tombstone
  // for a block that still exists would make copies skip a live slot. If this
  // write fails the block is still gone (there is no un-delete), so the
  // manager gets success with a warning rather than an error that invites a
  // retry against a block that no longer exists.
  if (block.template_id && block.block_date) {
    const { error: removalErr } = await db
      .from('shift_block_removals')
      .upsert({
        location_id: block.location_id,
        template_id: block.template_id,
        block_date: block.block_date,
        removed_by: user.id ?? null,
      }, { onConflict: 'location_id,template_id,block_date', ignoreDuplicates: true })
    if (removalErr) {
      logWarn('schedule-blocks', 'slot removal record failed; the nightly schedule may recreate it', {
        blockId: block.id, locationId: block.location_id, templateId: block.template_id,
        blockDate: block.block_date, err: removalErr,
      })
      return NextResponse.json({
        success: true,
        warning: 'Slot deleted, but it could not be marked as removed, so the nightly schedule may add it back. Delete it again if it reappears.',
      })
    }
  }

  return NextResponse.json({ success: true })
}

// BLOCKEDIT.1 — every field optional; omitted = unchanged. briefing: null or
// blank clears it. allow_below_assigned is the assign route's
// allow_over_capacity in reverse: a max under the coaches already on it.
const BlockEditSchema = z.object({
  start_time: timeOfDay.optional(),
  end_time: timeOfDay.optional(),
  min_coaches: z.number().int().min(0).max(50).optional(),
  max_coaches: z.number().int().min(1).max(50).optional(),
  briefing: z.string().max(BRIEFING_MAX_LENGTH).nullable().optional(),
  allow_below_assigned: z.boolean().optional(),
  // Review fix 2 — what the editor OPENED with. The web form always sends it;
  // a stored value that differs is a 409, so a form left open while another
  // manager saved cannot silently overwrite their change.
  expected: z.object({
    start_time: timeOfDay,
    end_time: timeOfDay,
    min_coaches: z.number().int(),
    max_coaches: z.number().int(),
  }).optional(),
})

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  // Not UUID-shaped: no such shift. Checked before the read, because Postgres
  // answers a malformed uuid with an ERROR (22P02), which would surface as the
  // read-failed 503 below and invite a retry that can never succeed.
  if (!uuidLike.safeParse(params.id).success) {
    return NextResponse.json({ success: false, error: 'Block not found' }, { status: 404 })
  }

  const validation = await validateBody(request, BlockEditSchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const { data: block, error: readErr } = await db
    .from('shift_blocks')
    // Literal IN the call on purpose: check:select-columns resolves only a
    // literal passed to .select() (a const holding the string is skipped in
    // silence). kind: SHIFTTYPE.1 (an admin shift has no minimum);
    // locations.timezone: the studio clock the quiet-hours answer is read in.
    .select(`
      id, location_id, template_id, block_date, start_time, end_time, min_coaches, max_coaches, briefing, roster_id,
      rosters:roster_id ( status ),
      locations:location_id ( timezone ),
      shift_templates ( name, kind ),
      shift_assignments ( id, profile_id, status, start_time_override, end_time_override, profiles:profile_id ( full_name ) )
    `)
    .eq('id', params.id)
    .maybeSingle()
  if (readErr) {
    // Not a 404: a failed read must not tell the manager the shift is gone.
    logWarn('schedule-blocks', 'block edit: could not read the block', { blockId: params.id, err: readErr })
    return NextResponse.json({ success: false, error: 'Could not read this shift. Try again.', transient: true }, { status: 503 })
  }
  if (!block) {
    return NextResponse.json({ success: false, error: 'Block not found' }, { status: 404 })
  }
  const notHere = assertLocationAccessOr404(user, block.location_id)
  if (notHere) return notHere
  if (!hasRoleAtLocation(user, block.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  if (!matchesExpected(block, validation.data.expected)) {
    return NextResponse.json({
      success: false, error: 'block_changed',
      message: 'Someone changed this shift since you opened it — reload it and try again.',
    }, { status: 409 })
  }

  const plan = planBlockEdit({ block, body: validation.data })
  if (!plan.ok) return NextResponse.json(plan.body, { status: plan.status })
  if (plan.unchanged) {
    return NextResponse.json({ success: true, unchanged: true, data: {
      id: block.id, start_time: block.start_time, end_time: block.end_time,
      min_coaches: block.min_coaches, max_coaches: block.max_coaches, briefing: block.briefing ?? null,
    } })
  }

  // 1. The block, guarded on what was read (D9): a concurrent edit is a 409,
  //    never a silent overwrite. A zero-row UPDATE is not an error in
  //    PostgREST, so the rows are judged.
  const { data: saved, error: saveErr } = await db
    .from('shift_blocks')
    .update(plan.patch)
    .eq('id', block.id)
    .eq('location_id', block.location_id)
    .eq('start_time', block.start_time)
    .eq('end_time', block.end_time)
    .eq('min_coaches', block.min_coaches)
    .eq('max_coaches', block.max_coaches)
    .select('id, start_time, end_time, min_coaches, max_coaches, briefing')
  if (saveErr) {
    if (saveErr.code === '23514') {
      return NextResponse.json({
        success: false, error: 'check_failed',
        message: 'That does not fit the rules for a shift: the end must be after the start, the minimum no more than the maximum, and a briefing at most 500 characters.',
      }, { status: 400 })
    }
    logWarn('schedule-blocks', 'block edit: update failed', { blockId: block.id, err: saveErr })
    return NextResponse.json({ success: false, error: saveErr.message }, { status: 500 })
  }
  if (!saved || saved.length === 0) {
    return NextResponse.json({
      success: false, error: 'block_changed',
      message: 'This shift changed while you were editing it. Close it, open it again and retry.',
    }, { status: 409 })
  }

  // 2. D3 — overrides equal to the OLD block time follow it. Guarded on the
  //    old value. A failure keeps that coach at the old override: the block
  //    edit stands, the coach is logged at the window they really have, and
  //    the manager is told.
  const stuck = new Set()
  for (const f of plan.followUpdates) {
    let q = db.from('shift_assignments').update(f.patch).eq('id', f.assignmentId).eq('block_id', block.id)
    for (const [col, val] of Object.entries(f.expect)) q = q.eq(col, val)
    const { data: moved, error: moveErr } = await q.select('id')
    if (moveErr || !moved || moved.length === 0) {
      stuck.add(f.assignmentId)
      logWarn('schedule-blocks', 'block edit: an override did not follow the shift', {
        blockId: block.id, assignmentId: f.assignmentId, err: moveErr || 'no row matched',
      })
    }
  }
  const warnings = [...plan.warnings]
  const stuckNames = (block.shift_assignments || [])
    .filter((a) => stuck.has(a.id))
    .map((a) => a.profiles?.full_name || 'A coach')
  if (stuckNames.length > 0) {
    warnings.push(`${stuckNames.join(', ')} still ${stuckNames.length === 1 ? 'has' : 'have'} the old hours: their own times could not be moved with the shift. Adjust them in the coach's row.`)
  }
  const affected = plan.affected
    .map((a) => (stuck.has(a.assignmentId) ? { ...a, to: a.toIfStuck } : a))
    .filter((a) => !sameWindow(a.from, a.to))

  // Review fix 4 — a moved or stretched shift can put a coach on two shifts at
  // once. The assign route's org-scoped advisory, on each moved coach's NEW
  // window: warned, never blocked, never throws (src/lib/shift-overlaps.js).
  let overlaps = []
  if (affected.length > 0) {
    const { clashes } = await findShiftOverlaps(db, {
      locationId: block.location_id,
      blockId: block.id,
      blockDate: block.block_date,
      windows: affected.map((a) => ({ profileId: a.coachId, start_time: a.to.start_time, end_time: a.to.end_time })),
      logTag: 'schedule-blocks',
    })
    overlaps = clashes.map((c) => ({ profile_id: c.profileId, message: c.text }))
    warnings.push(...clashes.map((c) => c.text))
  }

  // 3. D4/D5 — change log, published only. Best-effort: a lost audit row never
  //    fails a save that already happened.
  let notice = null
  if (block.rosters?.status === 'published') {
    await logBlockEdit(db, {
      isPublished: true, locationId: block.location_id, blockId: block.id,
      blockDate: block.block_date, actorId: user.id, details: plan.blockDetails,
    })
    const logged = []
    for (const a of affected) {
      const r = await logRosterChange(db, {
        isPublished: true,
        locationId: block.location_id,
        action: 'time_changed',
        coachId: a.coachId,
        actorId: user.id,
        blockId: block.id,
        blockDate: block.block_date,
        details: { source: TIME_CHANGE_SOURCE, from: a.from, to: a.to },
      })
      if (r?.logged) logged.push({ id: r.id, coachId: a.coachId, from: a.from, to: a.to })
    }
    // Nobody to tell: a shift already in the past, or the manager moved their
    // own shift. Stamped now so the notice arm and the re-publish safety net
    // leave them alone (stampMeansTold rules 3 and 4).
    const past = block.block_date < dublinTodayStr()
    const silent = logged.filter((r) => past || r.coachId === user.id)
    const silentIds = silent.map((r) => r.id)
    if (silentIds.length > 0) await markChangesNotified(db, silentIds)
    const toTell = logged.filter((r) => !silentIds.includes(r.id))
    if (toTell.length > 0) {
      // Review fix 3 — 'too_late' when the shift starts before anyone can be
      // told (quiet hours now, a start before 07:00 on the notice morning).
      notice = {
        coaches: toTell.length,
        when: blockEditNoticeWhen({ nowMs: Date.now(), timeZone: block.locations?.timezone, blockDate: block.block_date, windows: toTell }),
      }
    }
  }

  return NextResponse.json({
    success: true,
    data: saved[0],
    ...(notice ? { notice } : {}),
    ...(plan.kept.length > 0 ? { kept_overrides: plan.kept.map((k) => ({ assignment_id: k.assignmentId, profile_id: k.coachId })) } : {}),
    ...(overlaps.length > 0 ? { overlaps } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  })
}
