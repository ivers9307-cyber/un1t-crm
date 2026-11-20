// DELETE /api/contacts/[id]/consultation-photos/[pid] — delete a progress photo.
//
// CONSULTATIONS SP1 — progress-photo delete API.
//
// Authorization: session auth + consultations permission.
// [id] is the contact; [pid] is the photo row id.
// The storage object is removed best-effort before the DB row is deleted.

import { NextResponse } from 'next/server'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'

export const runtime = 'nodejs'

// ============================================================
// DELETE /api/contacts/[id]/consultation-photos/[pid]
// ============================================================
// Signed in (401), then `consultations` somewhere (the same 'Unauthorized'
// 403), then the photo (404), its studio (404) and the key there (403).
export const DELETE = withAuth({
  permission: null, location: false,
  allow: (user) => hasPermissionAtAnyLocation(user, 'consultations'), forbiddenMessage: 'Unauthorized',
}, async ({ user, db, params }) => {
  const { id: contactId, pid } = params

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

  const guard = assertLocationAccessOr404(user, photo.location_id)
  if (guard) return guard
  // ROLESWEEP.1c — `consultations` judged at the photo's location, not the active studio.
  if (!hasPermissionForLocation(user, photo.location_id, 'consultations')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

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
    logError('consultation-photos', 'delete failed', { photoId: pid, err: delErr })
    return NextResponse.json({ success: false, error: 'Could not delete the photo. Try again.' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
})
