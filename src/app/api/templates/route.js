import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

// GET /api/templates — list templates
export async function GET(request) {
  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')

  let query = db.from('email_templates')
    .select('id, name, description, category, thumbnail_url, created_at, updated_at')
    .order('updated_at', { ascending: false })

  if (locationId) query = query.eq('location_id', locationId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, templates: data })
}

// POST /api/templates — create template
export async function POST(request) {
  const db = createServerClient()
  const body = await request.json()

  const { data, error } = await db.from('email_templates').insert({
    name: body.name || 'Untitled Template',
    description: body.description || null,
    category: body.category || 'general',
    design_json: body.design_json || null,
    html_content: body.html_content || '',
    location_id: body.location_id,
    created_by: body.created_by,
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, template: data })
}
