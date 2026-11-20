// WAORGNUMBER.2 (R5) — which of a studio's own WhatsApp templates its
// automatic messages use.
//
// Senders that used to hard-code a template name (class booking confirmation,
// consultation confirmation, event waitlist offer, ad-lead welcome) resolve it
// per studio through resolvePurposeTemplate (src/lib/whatsapp-purpose-templates.js):
// locations.settings.whatsapp_purpose_templates[purpose] = a whatsapp_templates.id
// at that studio, else today's name at the studio.
//
// GET /api/locations/[id]/whatsapp/purpose-templates
//   Anyone with access to the studio. { selected: { <purpose>: id|null }, can_edit }.
//
// PUT /api/locations/[id]/whatsapp/purpose-templates   { purpose, templateId|null }
//   Owner / manager / master AT THIS STUDIO (ADMIN_ROLES; judged at the path id,
//   never on user.role). The template must be this studio's, APPROVED, and in a
//   category the purpose allows (400 otherwise). null clears the pick. The key is
//   merged into settings.whatsapp_purpose_templates; sibling settings keys and
//   the other purposes are left as they are. Responds with the GET shape.

import { NextResponse } from 'next/server'
import { assertLocationAccess } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { ADMIN_ROLES, studioPurposeTemplateSchema } from '@/lib/schemas'
import { hasRoleAtLocation } from '@/lib/role-at-location'
import { mergeLocationSettings, settingsSaveFailure } from '@/lib/location-settings'
import { PURPOSES, PURPOSE_KEYS } from '@/lib/whatsapp-purpose-templates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (error, status = 500) => NextResponse.json({ success: false, error }, { status })

function selectedFrom(settings) {
  const saved = settings?.whatsapp_purpose_templates
  const out = {}
  for (const purpose of PURPOSE_KEYS) {
    const id = saved && typeof saved === 'object' ? saved[purpose] : null
    out[purpose] = typeof id === 'string' && id ? id : null
  }
  return out
}

// withAuth signs the caller in and (location: 'param') 404s a studio they are
// not at; the hand-written checks below still decide, in their old order.
export const GET = withAuth({ permission: null, location: 'param' }, async ({ user, params }) => {
  const guard = assertLocationAccess(user, params.id)
  if (guard) return guard

  const db = createServerClient()
  const { data: location, error } = await db.from('locations').select('id, settings').eq('id', params.id).maybeSingle()
  if (error) {
    logError('wa-purpose-templates', 'studio read failed', { err: error, locationId: params.id })
    return fail('Could not load the studio.')
  }
  if (!location) return fail('Studio not found', 404)
  return NextResponse.json({
    success: true,
    data: { selected: selectedFrom(location.settings), can_edit: hasRoleAtLocation(user, params.id, ADMIN_ROLES) },
  })
})

export const PUT = withAuth({ permission: null, location: 'param' }, async ({ user, request, params }) => {
  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, ADMIN_ROLES)) {
    return fail('Only an owner or manager can choose the templates used for automatic messages at this studio.', 403)
  }

  const result = await validateBody(request, studioPurposeTemplateSchema)
  if (!result.ok) return result.response
  const { purpose, templateId } = result.data

  const db = createServerClient()

  if (templateId) {
    const { data: template, error: tplErr } = await db
      .from('whatsapp_templates')
      .select('id, location_id, status, category')
      .eq('id', templateId)
      .maybeSingle()
    if (tplErr) {
      logError('wa-purpose-templates', 'template read failed', { err: tplErr, locationId, templateId })
      return fail('Could not check that template.')
    }
    if (!template || template.location_id !== locationId) {
      return fail('That template does not belong to this studio.', 400)
    }
    if (template.status !== 'APPROVED') {
      return fail('Only an approved template can be used for automatic messages.', 400)
    }
    const allowed = PURPOSES[purpose].categories
    if (!allowed.includes(String(template.category || '').toUpperCase())) {
      return fail(`This message needs a ${allowed.join(' or ').toLowerCase()} template; that one is ${String(template.category || 'uncategorised').toLowerCase()}.`, 400)
    }
  }

  // Merge: never clobber the other purposes or sibling settings keys (SETTINGSWIPE.1:
  // a failed read writes nothing).
  const saved = await mergeLocationSettings(db, locationId, (settings) => {
    const current = settings.whatsapp_purpose_templates
    return { ...settings, whatsapp_purpose_templates: { ...(current && typeof current === 'object' ? current : {}), [purpose]: templateId } }
  }, { scope: 'wa-purpose-templates' })
  if (!saved.ok) return settingsSaveFailure(saved)

  return NextResponse.json({ success: true, data: { selected: selectedFrom(saved.settings), can_edit: true } })
})
