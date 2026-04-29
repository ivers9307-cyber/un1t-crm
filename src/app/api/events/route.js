import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// GET /api/events — List all event types
export async function GET(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const activeOnly = searchParams.get('active') === 'true'

  let query = db.from('event_types').select('*').order('created_at', { ascending: false })
  const locationId = searchParams.get('location_id')
  if (locationId) query = query.eq('location_id', locationId)
  if (activeOnly) query = query.eq('active', true)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}

// POST /api/events — Create a new event type
export async function POST(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const body = await request.json()
  const db = createServerClient()

  // Auto-generate slug from name if not provided
  const slug = body.slug || body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

  const { data, error } = await db.from('event_types').insert({
    name: body.name,
    slug,
    description: body.description || null,
    duration_minutes: body.duration_minutes || 30,
    color: body.color || '#3B82F6',
    availability: body.availability || undefined,
    buffer_minutes: body.buffer_minutes || 0,
    max_advance_days: body.max_advance_days || 30,
    custom_fields: body.custom_fields || [],
    webhook_url: body.webhook_url || null,
    active: body.active !== false,
    ...(body.location_id ? { location_id: body.location_id } : {}),
  }).select().single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}
