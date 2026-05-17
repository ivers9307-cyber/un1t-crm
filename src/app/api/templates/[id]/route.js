import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'

const TemplateUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().max(50).optional(),
  design_json: z.unknown().nullable().optional(),
  html_content: z.string().max(1_000_000).optional(),
})

async function loadTemplateLocation(db, id) {
  const { data } = await db.from('email_templates').select('location_id').eq('id', id).single()
  return data?.location_id
}

// GET /api/templates/[id]
export async function GET(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data, error } = await db.from('email_templates')
    .select('*')
    .eq('id', params.id)
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 404 })

  const guard = assertLocationAccess(user, data.location_id)
  if (guard) return guard

  return NextResponse.json({ success: true, template: data })
}

// PUT /api/templates/[id]
export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const loc = await loadTemplateLocation(db, params.id)
  if (!loc) return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
  const guard = assertLocationAccess(user, loc)
  if (guard) return guard

  const validation = await validateBody(request, TemplateUpdateSchema)
  if (!validation.ok) return validation.response
  const updates = { ...validation.data }

  const { data, error } = await db.from('email_templates')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, template: data })
}

// DELETE /api/templates/[id]
export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const loc = await loadTemplateLocation(db, params.id)
  if (!loc) return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
  const guard = assertLocationAccess(user, loc)
  if (guard) return guard

  const { error } = await db.from('email_templates').delete().eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
