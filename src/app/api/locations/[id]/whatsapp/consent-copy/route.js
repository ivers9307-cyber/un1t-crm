// WAORGNUMBER.3 (R6) — the reply a customer gets for STOP / START in a
// WhatsApp thread at this studio (customer-comms-editable rule).
//
// Since R6 a keyword acts at the studio whose thread it arrives in, and the
// acknowledgement names that studio (consentAckText, src/lib/whatsapp-consent-copy.js):
// locations.settings.whatsapp_consent_copy.{stop_ack, start_ack}, else the
// default. {studio} is replaced with the studio's name at send time.
//
// GET /api/locations/[id]/whatsapp/consent-copy
//   Anyone with access to the studio.
//   { copy: { stop_ack, start_ack } (null = default), defaults, studio_name, can_edit }
//
// PUT /api/locations/[id]/whatsapp/consent-copy   { stop_ack, start_ack }
//   Owner / manager / master AT THIS STUDIO (ADMIN_ROLES; judged at the path id,
//   never on user.role). Blank or null = back to the default. At most
//   CONSENT_COPY_MAX characters each. Merged into settings.whatsapp_consent_copy;
//   sibling settings keys are left as they are. Responds with the GET shape.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { ADMIN_ROLES, studioConsentCopySchema } from '@/lib/schemas'
import { hasRoleAtLocation } from '@/lib/role-at-location'
import { mergeLocationSettings, settingsSaveFailure } from '@/lib/location-settings'
import { CONSENT_COPY_KEYS, DEFAULT_CONSENT_COPY, savedConsentCopy } from '@/lib/whatsapp-consent-copy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (error, status = 500) => NextResponse.json({ success: false, error }, { status })

const shape = (settings, name, canEdit) => ({
  copy: savedConsentCopy(settings),
  defaults: DEFAULT_CONSENT_COPY,
  studio_name: name || null,
  can_edit: canEdit,
})

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return fail('Unauthorised', 401)
  const guard = assertLocationAccess(user, params.id)
  if (guard) return guard

  const db = createServerClient()
  const { data: location, error } = await db.from('locations').select('id, name, settings').eq('id', params.id).maybeSingle()
  if (error) return fail(error.message)
  if (!location) return fail('Studio not found', 404)
  return NextResponse.json({
    success: true,
    data: shape(location.settings, location.name, hasRoleAtLocation(user, params.id, ADMIN_ROLES)),
  })
}

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return fail('Unauthorised', 401)
  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, ADMIN_ROLES)) {
    return fail('Only an owner or manager can change the STOP and START replies at this studio.', 403)
  }

  const result = await validateBody(request, studioConsentCopySchema)
  if (!result.ok) return result.response

  const next = {}
  for (const key of CONSENT_COPY_KEYS) next[key] = result.data[key] ? result.data[key] : null

  const db = createServerClient()
  // Merge: never clobber sibling settings keys (SETTINGSWIPE.1: a failed read
  // writes nothing).
  const saved = await mergeLocationSettings(db, locationId, (settings) => ({ ...settings, whatsapp_consent_copy: next }), { scope: 'wa-consent-copy' })
  if (!saved.ok) return settingsSaveFailure(saved)

  // The name is only for the card's preview; a failed read leaves it null.
  const { data: location } = await db.from('locations').select('name').eq('id', locationId).maybeSingle()
  return NextResponse.json({ success: true, data: shape(saved.settings, location?.name, true) })
}
