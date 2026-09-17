// /api/schedule/blocks/[id] — DELETE
//
// Removes a shift_block. Cascades to shift_assignments via the FK
// on delete. (The old public.shifts mirror that the mig 068 trigger
// kept in sync was dropped in mig 238.)
//
// Only used for one-off "this slot doesn't apply this week"
// removals. The default lifecycle is template days_of_week →
// auto-generated blocks; deleting a block here doesn't change the
// template.
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
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { logWarn } from '@/lib/log'

export async function DELETE(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()

  // Fetch the block first so we can enforce per-location
  // ownership for non-master callers.
  const { data: block, error: fetchErr } = await db
    .from('shift_blocks')
    .select('id, location_id, template_id, block_date')
    .eq('id', params.id)
    .single()

  if (fetchErr || !block) {
    return NextResponse.json({ success: false, error: 'Block not found' }, { status: 404 })
  }

  if (user.role !== 'master') {
    const userLocationIds = getUserLocationIds(user)
    if (!userLocationIds.includes(block.location_id)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
  }

  const { error } = await db.from('shift_blocks').delete().eq('id', params.id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
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
