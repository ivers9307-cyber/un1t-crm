// GET    /api/presentations/[id]  — one deck + its ordered slides (resolved URLs)
// DELETE /api/presentations/[id]  — delete deck (cascade slides) + storage objects
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccess } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NOT_AUTHORISED = 'Not authorised for presentations'
function deny() {
  return NextResponse.json({ success: false, error: NOT_AUTHORISED }, { status: 403 })
}
// `presentations` somewhere (403), then the deck's studio (404) and
// `presentations` there (403), as before. A signed-out call is a 401 now.
const GATE = { permission: null, location: false, allow: (user) => hasPermissionAtAnyLocation(user, 'presentations'), forbiddenMessage: NOT_AUTHORISED }
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
  // ROLESWEEP.1a — the permission is judged at the deck's location.
  if (!hasPermissionForLocation(user, row.location_id, 'presentations')) return { denied: true }
  return { row }
}

export const GET = withAuth(GATE, async ({ user, db, params }) => {
  const id = params?.id
  const { row, notFound, denied } = await loadOwned(db, user, id)
  if (notFound) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (denied) return deny()
  const { data: slides } = await db
    .from('presentation_slides')
    .select('id, position, image_path')
    .eq('presentation_id', id)
    .order('position', { ascending: true })
  return NextResponse.json({
    success: true,
    presentation: { ...row, slides: (slides || []).map((s) => ({ id: s.id, position: s.position, url: bucketUrl(s.image_path) })) },
  })
})

export const DELETE = withAuth(GATE, async ({ user, db, params }) => {
  const id = params?.id
  const { notFound, denied } = await loadOwned(db, user, id)
  if (notFound) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (denied) return deny()
  // Best-effort storage cleanup, then the row (cascade removes slide rows).
  const { data: slides } = await db.from('presentation_slides').select('image_path').eq('presentation_id', id)
  const paths = (slides || []).map((s) => s.image_path)
  if (paths.length) { try { await db.storage.from('presentation-slides').remove(paths) } catch { /* best effort */ } }
  const { error } = await db.from('presentations').delete().eq('id', id)
  if (error) {
    logError('presentations', 'delete failed', { presentationId: id, err: error })
    return NextResponse.json({ success: false, error: 'Could not delete the deck. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
})
