// DELETE /api/presentations/[id]/slides/[slideId]
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccess } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NOT_AUTHORISED = 'Not authorised for presentations'

// `presentations` somewhere (403) before the read, then the deck's studio (404)
// and `presentations` there (403), as before. A signed-out call is a 401 now.
export const DELETE = withAuth(
  { permission: null, location: false, allow: (user) => hasPermissionAtAnyLocation(user, 'presentations'), forbiddenMessage: NOT_AUTHORISED },
  async ({ user, db, params }) => {
    const { id, slideId } = params || {}
    const { data: deck } = await db.from('presentations').select('id, location_id, version').eq('id', id).maybeSingle()
    if (!deck || assertLocationAccess(user, deck.location_id)) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    // ROLESWEEP.1a — the permission is judged at the deck's location.
    if (!hasPermissionForLocation(user, deck.location_id, 'presentations')) {
      return NextResponse.json({ success: false, error: NOT_AUTHORISED }, { status: 403 })
    }
    const { data: slide } = await db.from('presentation_slides')
      .select('id, image_path').eq('id', slideId).eq('presentation_id', id).maybeSingle()
    if (!slide) return NextResponse.json({ success: false, error: 'Slide not found' }, { status: 404 })
    try { await db.storage.from('presentation-slides').remove([slide.image_path]) } catch { /* best effort */ }
    const { error } = await db.from('presentation_slides').delete().eq('id', slideId)
    if (error) {
      logError('presentations', 'slide delete failed', { presentationId: id, slideId, err: error })
      return NextResponse.json({ success: false, error: 'Could not delete the slide. Try again.' }, { status: 500 })
    }
    // PRESENTSAFE.1 — a failed bump leaves open screens on the old deck: say so.
    const { error: bumpErr } = await db.rpc('bump_presentation_version', { p_presentation_id: id })
    if (bumpErr) {
      logError('presentations', 'version bump failed after slide delete', { presentationId: id, error: bumpErr.message })
      return NextResponse.json({ success: true, warning: 'Deleted, but open screens did not get the update. Reload them.' })
    }
    return NextResponse.json({ success: true })
  },
)
