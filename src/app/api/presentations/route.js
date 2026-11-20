// GET  /api/presentations?location_id=<uuid>  — list decks at a location
// POST /api/presentations                      — create a deck { location_id, title }
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccess, getUserLocationIds } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NOT_AUTHORISED = 'Not authorised for presentations'
function deny() {
  return NextResponse.json({ success: false, error: NOT_AUTHORISED }, { status: 403 })
}
// `presentations` somewhere (403), then the studio asked for and
// `presentations` there, as before. A signed-out call is a 401 now.
const GATE = { permission: null, location: false, allow: (user) => hasPermissionAtAnyLocation(user, 'presentations'), forbiddenMessage: NOT_AUTHORISED }

export const GET = withAuth(GATE, async ({ user, db, request }) => {
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>' }, { status: 400 })
  }
  if (!user.isMaster && !getUserLocationIds(user).includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Location not in your scope' }, { status: 403 })
  }
  // ROLESWEEP.1a — the permission is judged at the location listed.
  if (!hasPermissionForLocation(user, locationId, 'presentations')) return deny()
  const { data, error } = await db
    .from('presentations')
    .select('id, title, view_token, current_index, version, created_at, updated_at, presentation_slides(id)')
    .eq('location_id', locationId)
    .order('updated_at', { ascending: false })
  if (error) {
    logError('presentations', 'list failed', { locationId, err: error })
    return NextResponse.json({ success: false, error: 'Could not load the decks. Try again.' }, { status: 500 })
  }
  const presentations = (data || []).map((p) => ({
    id: p.id, title: p.title, view_token: p.view_token,
    current_index: p.current_index, version: p.version,
    created_at: p.created_at, updated_at: p.updated_at,
    slide_count: (p.presentation_slides || []).length,
  }))
  return NextResponse.json({ success: true, presentations })
})

const CreateSchema = z.object({ location_id: uuidLike, title: z.string().min(1).max(120) })

export const POST = withAuth(GATE, async ({ user, db, request }) => {
  const validation = await validateBody(request, CreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, body.location_id, 'presentations')) return deny()
  const { data, error } = await db
    .from('presentations')
    .insert({ location_id: body.location_id, title: body.title.trim(), created_by: user.id })
    .select('id, title, view_token, current_index, version')
    .single()
  if (error) {
    logError('presentations', 'create failed', { locationId: body.location_id, err: error })
    return NextResponse.json({ success: false, error: 'Could not create the deck. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, presentation: data })
})
