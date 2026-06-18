// DELETE /api/presentations/[id]/slides/[slideId]
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) {
    return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
  }
  const { id, slideId } = await params
  const db = createServerClient()
  const { data: deck } = await db.from('presentations').select('id, location_id, version').eq('id', id).maybeSingle()
  if (!deck || assertLocationAccess(user, deck.location_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const { data: slide } = await db.from('presentation_slides')
    .select('id, image_path').eq('id', slideId).eq('presentation_id', id).maybeSingle()
  if (!slide) return NextResponse.json({ success: false, error: 'Slide not found' }, { status: 404 })
  try { await db.storage.from('presentation-slides').remove([slide.image_path]) } catch { /* best effort */ }
  const { error } = await db.from('presentation_slides').delete().eq('id', slideId)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  await db.from('presentations').update({ version: deck.version + 1, updated_at: new Date().toISOString() }).eq('id', id)
  return NextResponse.json({ success: true })
}
