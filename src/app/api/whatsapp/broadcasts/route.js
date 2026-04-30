import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess , getUserLocationIds} from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, audienceFilterSchema, url } from '@/lib/schemas'

const BroadcastCreateSchema = z.object({
  name: z.string().min(1).max(200),
  template_id: uuidLike,
  variable_mapping: z.unknown().optional(),
  header_media_url: url.nullable().optional(),
  audience_filter: audienceFilterSchema,
  location_id: uuidLike.optional(),
})

// GET /api/whatsapp/broadcasts
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  let query = db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(name, category, status)')
    .order('created_at', { ascending: false })

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, broadcasts: [] })
    query = query.in('location_id', userLocationIds)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, broadcasts: data })
}

// POST /api/whatsapp/broadcasts
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, BroadcastCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const locationId = body.location_id || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db.from('whatsapp_broadcasts').insert({
    name: body.name || 'Untitled Broadcast',
    template_id: body.template_id,
    variable_mapping: body.variable_mapping || {},
    header_media_url: body.header_media_url || null,
    audience_filter: body.audience_filter || { filters: [], logic: 'and' },
    status: 'draft',
    location_id: locationId,
    created_by: user.id,
  }).select().single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, broadcast: data })
}
