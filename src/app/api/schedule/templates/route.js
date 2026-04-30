import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'

const TIME = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM or HH:MM:SS')
const HEX_COLOR = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use #RRGGBB hex')

const CreateTemplateSchema = z.object({
  location_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  start_time: TIME,
  end_time: TIME,
  color: HEX_COLOR.optional(),
  role_label: z.string().max(50).nullable().optional(),
  display_order: z.number().int().min(0).max(1000).optional(),
})

// GET /api/schedule/templates?location_id=xxx
export async function GET(request) {
  const user = await getCurrentUser()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  let query = db.from('shift_templates').select('*').order('display_order').order('start_time')
  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = (user.locations || []).map(l => l.id)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, data: [] })
    query = query.in('location_id', userLocationIds)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

// POST /api/schedule/templates — Create a shift template
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !['owner', 'manager', 'head_coach'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, CreateTemplateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db.from('shift_templates').insert({
    location_id: body.location_id,
    name: body.name,
    start_time: body.start_time,
    end_time: body.end_time,
    color: body.color || '#3B82F6',
    role_label: body.role_label || null,
    display_order: body.display_order || 0,
  }).select().single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data }, { status: 201 })
}
