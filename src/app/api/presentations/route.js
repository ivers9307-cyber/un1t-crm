// GET  /api/presentations?location_id=<uuid>  — list decks at a location
// POST /api/presentations                      — create a deck { location_id, title }
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function deny() {
  return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) return deny()
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>' }, { status: 400 })
  }
  if (!user.isMaster && !getUserLocationIds(user).includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Location not in your scope' }, { status: 403 })
  }
  const db = createServerClient()
  const { data, error } = await db
    .from('presentations')
    .select('id, title, view_token, current_index, version, created_at, updated_at, presentation_slides(id)')
    .eq('location_id', locationId)
    .order('updated_at', { ascending: false })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  const presentations = (data || []).map((p) => ({
    id: p.id, title: p.title, view_token: p.view_token,
    current_index: p.current_index, version: p.version,
    created_at: p.created_at, updated_at: p.updated_at,
    slide_count: (p.presentation_slides || []).length,
  }))
  return NextResponse.json({ success: true, presentations })
}

const CreateSchema = z.object({ location_id: uuidLike, title: z.string().min(1).max(120) })

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) return deny()
  const validation = await validateBody(request, CreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard
  const db = createServerClient()
  const { data, error } = await db
    .from('presentations')
    .insert({ location_id: body.location_id, title: body.title.trim(), created_by: user.id })
    .select('id, title, view_token, current_index, version')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, presentation: data })
}
