import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { deleteTemplate as deleteMetaTemplate } from '@/lib/whatsapp'

// GET /api/whatsapp/templates/[id]
export async function GET(request, { params }) {
  const db = createServerClient()
  const { data, error } = await db.from('whatsapp_templates')
    .select('*')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  return NextResponse.json({ success: true, template: data })
}

// PUT /api/whatsapp/templates/[id] — update local record
export async function PUT(request, { params }) {
  const db = createServerClient()
  const body = await request.json()

  const updates = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.category !== undefined) updates.category = body.category
  if (body.components !== undefined) updates.components = body.components
  if (body.example_values !== undefined) updates.example_values = body.example_values
  if (body.status !== undefined) updates.status = body.status

  const { data, error } = await db.from('whatsapp_templates')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, template: data })
}

// DELETE /api/whatsapp/templates/[id]
export async function DELETE(request, { params }) {
  const db = createServerClient()

  // Get template name to delete from Meta
  const { data: template } = await db.from('whatsapp_templates')
    .select('name')
    .eq('id', params.id)
    .single()

  if (template?.name) {
    try {
      await deleteMetaTemplate(template.name)
    } catch (err) {
      console.error('Meta template delete error:', err)
    }
  }

  const { error } = await db.from('whatsapp_templates').delete().eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
