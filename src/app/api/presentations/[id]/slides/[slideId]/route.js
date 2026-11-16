// DELETE /api/presentations/[id]/slides/[slideId]
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermissionAtAnyLocation(user, 'presentations')) {
    return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
  }
  const { id, slideId } = await params
  const db = createServerClient()
  const { data: deck } = await db.from('presentations').select('id, location_id, version').eq('id', id).maybeSingle()
  if (!deck || assertLocationAccess(user, deck.location_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  // ROLESWEEP.1a — the permission is judged at the deck's location.
  if (!hasPermissionForLocation(user, deck.location_id, 'presentations')) {
    return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
  }
  const { data: slide } = await db.from('presentation_slides')
    .select('id, image_path').eq('id', slideId).eq('presentation_id', id).maybeSingle()
  if (!slide) return NextResponse.json({ success: false, error: 'Slide not found' }, { status: 404 })
  try { await db.storage.from('presentation-slides').remove([slide.image_path]) } catch { /* best effort */ }
  const { error } = await db.from('presentation_slides').delete().eq('id', slideId)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  // PRESENTSAFE.1 — a failed bump leaves open screens on the old deck: say so.
  const { error: bumpErr } = await db.rpc('bump_presentation_version', { p_presentation_id: id })
  if (bumpErr) {
    logError('presentations', 'version bump failed after slide delete', { presentationId: id, error: bumpErr.message })
    return NextResponse.json({ success: true, warning: 'Deleted, but open screens did not get the update. Reload them.' })
  }
  return NextResponse.json({ success: true })
}
