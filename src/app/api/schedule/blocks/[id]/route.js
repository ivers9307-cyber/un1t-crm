// /api/schedule/blocks/[id] — DELETE
//
// Removes a shift_block. Cascades to shift_assignments via the FK
// on delete, which the mig 068 trigger then mirrors out to the
// legacy public.shifts table.
//
// Only used for one-off "this slot doesn't apply this week"
// removals. The default lifecycle is template days_of_week →
// auto-generated blocks; deleting a block here doesn't change the
// template, so the next regeneration window will recreate it.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()

  // Fetch the block first so we can enforce per-location
  // ownership for non-master callers.
  const { data: block, error: fetchErr } = await db
    .from('shift_blocks')
    .select('id, location_id')
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
  return NextResponse.json({ success: true })
}
