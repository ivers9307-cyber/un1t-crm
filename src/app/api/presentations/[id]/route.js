// GET    /api/presentations/[id]  — one deck + its ordered slides (resolved URLs)
// DELETE /api/presentations/[id]  — delete deck (cascade slides) + storage objects
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function deny() {
  return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
}
function bucketUrl(path) {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/presentation-slides/${path}`
}
async function loadOwned(db, user, id) {
  const { data: row } = await db
    .from('presentations')
    .select('id, location_id, title, view_token, current_index, version')
    .eq('id', id)
    .maybeSingle()
  if (!row) return { notFound: true }
  if (assertLocationAccess(user, row.location_id)) return { notFound: true }
  return { row }
}

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) return deny()
  const { id } = await params
  const db = createServerClient()
  const { row, notFound } = await loadOwned(db, user, id)
  if (notFound) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const { data: slides } = await db
    .from('presentation_slides')
    .select('id, position, image_path')
    .eq('presentation_id', id)
    .order('position', { ascending: true })
  return NextResponse.json({
    success: true,
    presentation: { ...row, slides: (slides || []).map((s) => ({ id: s.id, position: s.position, url: bucketUrl(s.image_path) })) },
  })
}

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) return deny()
  const { id } = await params
  const db = createServerClient()
  const { notFound } = await loadOwned(db, user, id)
  if (notFound) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  // Best-effort storage cleanup, then the row (cascade removes slide rows).
  const { data: slides } = await db.from('presentation_slides').select('image_path').eq('presentation_id', id)
  const paths = (slides || []).map((s) => s.image_path)
  if (paths.length) { try { await db.storage.from('presentation-slides').remove(paths) } catch { /* best effort */ } }
  const { error } = await db.from('presentations').delete().eq('id', id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
