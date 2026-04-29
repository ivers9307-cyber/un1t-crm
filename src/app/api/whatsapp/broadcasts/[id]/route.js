import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

// GET /api/whatsapp/broadcasts/[id]
export async function GET(request, { params }) {
  const db = createServerClient()
  const { data, error } = await db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(*), whatsapp_broadcast_recipients(*, contacts(name, phone, wa_phone))')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  return NextResponse.json({ success: true, broadcast: data })
}

// PUT /api/whatsapp/broadcasts/[id]
export async function PUT(request, { params }) {
  const db = createServerClient()
  const body = await request.json()

  const updates = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.template_id !== undefined) updates.template_id = body.template_id
  if (body.variable_mapping !== undefined) updates.variable_mapping = body.variable_mapping
  if (body.header_media_url !== undefined) updates.header_media_url = body.header_media_url
  if (body.audience_filter !== undefined) updates.audience_filter = body.audience_filter
  if (body.status !== undefined) updates.status = body.status

  const { data, error } = await db.from('whatsapp_broadcasts')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, broadcast: data })
}

// DELETE /api/whatsapp/broadcasts/[id]
export async function DELETE(request, { params }) {
  const db = createServerClient()
  await db.from('whatsapp_broadcast_recipients').delete().eq('broadcast_id', params.id)
  const { error } = await db.from('whatsapp_broadcasts').delete().eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
