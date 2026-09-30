// src/app/api/whatsapp/templates/[id]/resubmit/route.js
// POST — edit a REJECTED/PAUSED template's category+components via Meta and put it
// back into review. Manager-gated. The status flip back to APPROVED/REJECTED
// arrives later via the message_template_status_update webhook.
import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { editTemplate } from '@/lib/whatsapp'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
import { componentsButtonsError } from '@/lib/whatsapp-template-buttons'
import { ownNumberOrRefusal } from '@/lib/whatsapp-own-number'
import { templateHeaderMediaError } from '@/lib/template-media'

const ResubmitSchema = z.object({
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
  components: z.array(z.unknown()),
  // WATPLRESUBMEDIA.1 — a NEW header file uploaded in the editor. Sent only
  // when it differs from the stored one (resubmitMediaFields); absent = the
  // stored media stays. Same bounds as the create/PUT routes.
  header_media_handle: z.string().max(4000).nullable().optional(),
  header_media_url: z.string().url().max(2000).nullable().optional(),
  header_media_path: z.string().max(500).nullable().optional(),
})

// The header format the resubmitted components declare ('IMAGE', 'TEXT', …) or ''.
function headerFormatOf(components) {
  const header = (components || []).find((c) => String(c?.type || '').toUpperCase() === 'HEADER')
  return String(header?.format || '').toUpperCase()
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: tmpl, error: readError } = await db.from('whatsapp_templates')
    .select('id, location_id, status, meta_template_id, header_media_url, header_media_path')
    .eq('id', params.id)
    .single()
  // A failed read is never an empty answer. PGRST116 = no row (a real 404).
  if (readError && readError.code !== 'PGRST116') {
    return NextResponse.json({ success: false, error: 'Could not read that template. Try again.' }, { status: 500 })
  }
  if (!tmpl) return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })

  const guard = assertLocationAccessOr404(user, tmpl.location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, tmpl.location_id, MANAGER_ROLES)) {
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

  // WATPLRESUBMEDIA.1 — Meta gets the new header through the components'
  // header_handle, but every send attaches the row's header_media_url, so a
  // resubmit that kept the old url sent customers the OLD picture forever.
  // New media is judged like an upload (./upload-media): a minted path in this
  // template's studio folder of 'whatsapp-templates', of the header's type, at
  // the URL the bucket serves for it. Media identical to what the row already
  // stores is not re-judged (an older path keeps working); its handle is kept.
  const mediaPatch = {}
  const sendsMedia = ['header_media_url', 'header_media_path', 'header_media_handle'].some((k) => body[k] !== undefined)
  if (sendsMedia) {
    const url = body.header_media_url ?? null
    const path = body.header_media_path ?? null
    const unchanged = url === (tmpl.header_media_url ?? null) && path === (tmpl.header_media_path ?? null)
    if (!unchanged) {
      const publicUrl = path ? db.storage.from('whatsapp-templates').getPublicUrl(path)?.data?.publicUrl : null
      const mediaError = templateHeaderMediaError({
        path, url, publicUrl, format: headerFormatOf(body.components), locationId: tmpl.location_id,
      })
      if (mediaError) return NextResponse.json({ success: false, error: mediaError }, { status: 400 })
      mediaPatch.header_media_url = url
      mediaPatch.header_media_path = path
    }
    if (body.header_media_handle !== undefined) mediaPatch.header_media_handle = body.header_media_handle
  }

  // WACONFIGFALLBACK.1 — edit with THIS template's location's own number. The
  // call named no location, so it always used the global env token.
  const own = await ownNumberOrRefusal(tmpl.location_id, 'wa-templates-resubmit')
  if (!own.ok) return NextResponse.json({ success: false, error: own.error }, { status: own.status })

  try {
    await editTemplate(tmpl.meta_template_id, { category: body.category, components: body.components }, { config: own.config })

    const { data, error } = await db.from('whatsapp_templates')
      .update({
        status: 'PENDING',
        rejection_reason: null,
        components: body.components,
        ...mediaPatch,
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
