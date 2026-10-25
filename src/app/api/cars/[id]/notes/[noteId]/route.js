// DELETE /api/cars/[id]/notes/[noteId]
//
// Removes a note. System notes are deletable too — operators may
// want to clean up after testing.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const db = createServerClient()
  // Authz reads the note's own denormalised location_id. Every insert copies
  // it from the car (cars/[id]/notes POST, issue-deposit-link; the retired
  // deposit-receipts.js did too), and the car_id filter pins the note to
  // this car.
  const { data: note } = await db
    .from('car_notes')
    .select('id, location_id')
    .eq('id', params.noteId)
    .eq('car_id', params.id)
    .maybeSingle()
  if (!note) return NextResponse.json({ success: false, error: 'Note not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, note.location_id)
  if (guard) return guard
  // ROLESWEEP.1b — judged at the note's location_id (the car's location, copied
  // on insert), not the caller's active studio.
  if (!hasPermissionForLocation(user, note.location_id, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const { error } = await db.from('car_notes').delete().eq('id', params.noteId)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
