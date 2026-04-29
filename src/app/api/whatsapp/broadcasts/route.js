import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

// GET /api/whatsapp/broadcasts
export async function GET(request) {
  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')

  let query = db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(name, category, status)')
    .order('created_at', { ascending: false })

  if (locationId) query = query.eq('location_id', locationId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, broadcasts: data })
}

// POST /api/whatsapp/broadcasts
export async function POST(request) {
  const db = createServerClient()
  const body = await request.json()

  const { data, error } = await db.from('whatsapp_broadcasts').insert({
    name: body.name || 'Untitled Broadcast',
    template_id: body.template_id,
    variable_mapping: body.variable_mapping || {},
    header_media_url: body.header_media_url || null,
    audience_filter: body.audience_filter || { filters: [], logic: 'and' },
    status: 'draft',
    location_id: body.location_id,
    created_by: body.created_by,
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, broadcast: data })
}
