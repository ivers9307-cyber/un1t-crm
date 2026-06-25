import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, audienceFilterSchema, url } from '@/lib/schemas'

const BroadcastUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  template_id: uuidLike.optional(),
  variable_mapping: z.unknown().optional(),
  header_media_url: url.nullable().optional(),
  audience_filter: audienceFilterSchema,
  status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'cancelled']).optional(),
})

async function loadBroadcastLocation(db, id) {
  const { data } = await db.from('whatsapp_broadcasts').select('location_id').eq('id', id).single()
  return data?.location_id
}

// GET /api/whatsapp/broadcasts/[id]
export async function GET(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data, error } = await db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(*), whatsapp_broadcast_recipients(*, contacts(name, phone, wa_phone))')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 404 })

  const guard = assertLocationAccessOr404(user, data.location_id)
  if (guard) return guard

  return NextResponse.json({ success: true, broadcast: data })
}

// PUT /api/whatsapp/broadcasts/[id]
export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const loc = await loadBroadcastLocation(db, params.id)
  if (!loc) return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, loc)
  if (guard) return guard

  const validation = await validateBody(request, BroadcastUpdateSchema)
  if (!validation.ok) return validation.response
  const updates = { ...validation.data }

  const { data, error } = await db.from('whatsapp_broadcasts')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, broadcast: data })
}

// DELETE /api/whatsapp/broadcasts/[id]
export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const loc = await loadBroadcastLocation(db, params.id)
  if (!loc) return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, loc)
  if (guard) return guard

  await db.from('whatsapp_broadcast_recipients').delete().eq('broadcast_id', params.id)
  const { error } = await db.from('whatsapp_broadcasts').delete().eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
