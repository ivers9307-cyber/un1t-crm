// /api/schedule/assignments/[id] — DELETE
//
// Removes a coach from a shift_block. The mig 068 trigger then
// removes the corresponding legacy public.shifts row.
//
// Coaches can remove themselves; managers can remove anyone at a
// location they own.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()

  // Pull the assignment + parent block so we can authorise.
  const { data: assignment, error: fetchErr } = await db
    .from('shift_assignments')
    .select('id, profile_id, block_id, shift_blocks!block_id(location_id)')
    .eq('id', params.id)
    .single()

  if (fetchErr || !assignment) {
    return NextResponse.json({ success: false, error: 'Assignment not found' }, { status: 404 })
  }

  const isSelf = assignment.profile_id === user.id
  const isManager = MANAGER_ROLES.includes(user.role)

  if (!isSelf && !isManager) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // Per-location ownership check for non-master managers.
  if (isManager && user.role !== 'master') {
    const userLocationIds = getUserLocationIds(user)
    const blockLocation = assignment.shift_blocks?.location_id
    if (blockLocation && !userLocationIds.includes(blockLocation)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
  }

  const { error } = await db.from('shift_assignments').delete().eq('id', params.id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }
  return NextResponse.json({ success: true })
}
