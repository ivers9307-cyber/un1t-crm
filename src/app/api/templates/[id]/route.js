import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

// GET /api/templates/[id]
export async function GET(request, { params }) {
  const db = createServerClient()
  const { data, error } = await db.from('email_templates')
    .select('*')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  return NextResponse.json({ success: true, template: data })
}

// PUT /api/templates/[id]
export async function PUT(request, { params }) {
  const db = createServerClient()
  const body = await request.json()

  const updates = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.description !== undefined) updates.description = body.description
  if (body.category !== undefined) updates.category = body.category
  if (body.design_json !== undefined) updates.design_json = body.design_json
  if (body.html_content !== undefined) updates.html_content = body.html_content

  const { data, error } = await db.from('email_templates')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, template: data })
}

// DELETE /api/templates/[id]
export async function DELETE(request, { params }) {
  const db = createServerClient()
  const { error } = await db.from('email_templates').delete().eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
