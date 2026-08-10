// src/app/api/whatsapp/templates/[id]/resubmit/route.js
// POST — edit a REJECTED/PAUSED template's category+components via Meta and put it
// back into review. Manager-gated. The status flip back to APPROVED/REJECTED
// arrives later via the message_template_status_update webhook.
import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { editTemplate } from '@/lib/whatsapp'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
import { componentsButtonsError } from '@/lib/whatsapp-template-buttons'

const ResubmitSchema = z.object({
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
  components: z.array(z.unknown()),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: tmpl } = await db.from('whatsapp_templates')
    .select('id, location_id, status, meta_template_id')
    .eq('id', params.id)
    .single()
  if (!tmpl) return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })

  const guard = assertLocationAccessOr404(user, tmpl.location_id)
  if (guard) return guard
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  if (!['REJECTED', 'PAUSED'].includes(tmpl.status)) {
    return NextResponse.json({ success: false, error: `Only REJECTED or PAUSED templates can be resubmitted (this one is ${tmpl.status}).` }, { status: 400 })
  }
  if (!tmpl.meta_template_id) {
    return NextResponse.json({ success: false, error: 'Template has no Meta ID — recreate it instead.' }, { status: 400 })
  }

  const validation = await validateBody(request, ResubmitSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Same button rules as a fresh submit — a resubmit hits the same Meta wall.
  const buttonError = componentsButtonsError(body.components)
  if (buttonError) return NextResponse.json({ success: false, error: buttonError }, { status: 400 })

  try {
    await editTemplate(tmpl.meta_template_id, { category: body.category, components: body.components })

    const { data, error } = await db.from('whatsapp_templates')
      .update({
        status: 'PENDING',
        rejection_reason: null,
        components: body.components,
        ...(body.category ? { category: body.category } : {}),
      })
      .eq('id', params.id)
      .select()
      .single()
    if (error) throw new Error(error.message)

    return NextResponse.json({ success: true, template: data })
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 400 })
  }
}
