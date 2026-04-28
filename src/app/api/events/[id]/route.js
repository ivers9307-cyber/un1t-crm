import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// GET /api/events/:id — Get single event type with bookings count
export async function GET(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = createServerClient()
  const { data, error } = await db.from('event_types').select('*').eq('id', params.id).single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 404 })

  return NextResponse.json({ success: true, data })
}

// PUT /api/events/:id — Update event type
export async function PUT(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const body = await request.json()
  const db = createServerClient()

  const allowed = ['name', 'slug', 'description', 'duration_minutes', 'color', 'active',
    'availability', 'buffer_minutes', 'max_advance_days', 'custom_fields', 'webhook_url']
  const updates = {}
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key]
  }

  // Re-generate slug if name changed and slug not explicitly set
  if (updates.name && !updates.slug) {
    updates.slug = updates.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  }

  const { data, error } = await db.from('event_types').update(updates).eq('id', params.id).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}

// DELETE /api/events/:id — Deactivate event type (soft delete)
export async function DELETE(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = createServerClient()
  const { data, error } = await db.from('event_types').update({ active: false }).eq('id', params.id).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}
