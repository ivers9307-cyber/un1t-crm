import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { deleteTemplate as deleteMetaTemplate } from '@/lib/whatsapp'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'

const TemplateUpdateSchema = z.object({
  name: z.string().max(200).optional(),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
  components: z.array(z.unknown()).optional(),
  example_values: z.unknown().optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PAUSED']).optional(),
  // Media-header upload fields (mig 045) — see notes on the create
  // route for what these are.
  header_media_handle: z.string().max(500).nullable().optional(),
  header_media_url: z.string().url().max(2000).nullable().optional(),
  header_media_path: z.string().max(500).nullable().optional(),
})

async function loadTemplateLocation(db, id) {
  const { data } = await db.from('whatsapp_templates').select('location_id').eq('id', id).single()
  return data?.location_id
}

// GET /api/whatsapp/templates/[id]
export async function GET(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data, error } = await db.from('whatsapp_templates')
    .select('*')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 404 })

  const guard = assertLocationAccess(user, data.location_id)
  if (guard) return guard

  return NextResponse.json({ success: true, template: data })
}

// PUT /api/whatsapp/templates/[id] — update local record
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

  const { data, error } = await db.from('whatsapp_templates')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, template: data })
}

// DELETE /api/whatsapp/templates/[id]
export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()

  // Get template name + location to delete from Meta and verify access
  const { data: template } = await db.from('whatsapp_templates')
    .select('name, location_id')
    .eq('id', params.id)
    .single()
  if (!template) return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })

  const guard = assertLocationAccess(user, template.location_id)
  if (guard) return guard

  if (template.name) {
    try {
      await deleteMetaTemplate(template.name)
    } catch (err) {
      console.error('Meta template delete error:', err)
    }
  }

  const { error } = await db.from('whatsapp_templates').delete().eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
