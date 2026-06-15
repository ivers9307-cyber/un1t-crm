// DELETE /api/contacts/[id]/consultation-photos/[pid] — delete a progress photo.
//
// CONSULTATIONS SP1 — progress-photo delete API.
//
// Authorization: session auth + consultations permission.
// [id] is the contact; [pid] is the photo row id.
// The storage object is removed best-effort before the DB row is deleted.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const runtime = 'nodejs'

// ============================================================
// DELETE /api/contacts/[id]/consultation-photos/[pid]
// ============================================================
export async function DELETE(_request, props) {
  const params = await props.params
  const { id: contactId, pid } = params

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'consultations')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()

  // Load the photo row scoped to the contact (prevents IDOR)
  const { data: photo, error: photoErr } = await db
    .from('consultation_photos')
    .select('id, contact_id, location_id, storage_path')
    .eq('id', pid)
    .eq('contact_id', contactId)
    .single()

  if (photoErr || !photo) {
    return NextResponse.json({ success: false, error: 'Photo not found' }, { status: 404 })
  }

  const guard = assertLocationAccess(user, photo.location_id)
  if (guard) return guard

  // Remove storage object best-effort — swallow errors so a missing
  // file (e.g. manually cleaned up) doesn't block the row deletion.
  try {
    await db.storage.from('consultation-photos').remove([photo.storage_path])
  } catch {
    // swallow
  }

  const { error: delErr } = await db
    .from('consultation_photos')
    .delete()
    .eq('id', pid)

  if (delErr) {
    return NextResponse.json({ success: false, error: delErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
