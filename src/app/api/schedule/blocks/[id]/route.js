// /api/schedule/blocks/[id] — DELETE
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

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { isLiveAssignment } from '@/lib/roster'
import { logAndNotifyUnassignments } from '@/lib/shift-unassign'
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
