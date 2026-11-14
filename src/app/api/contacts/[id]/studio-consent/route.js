// STAFFCONSENT.1 — staff switch a contact's marketing email on or off for ONE
// studio, with a required reason (Richard, 14 Nov 2026).
//
// Who: ADMIN_ROLES at that studio, or master. Which contacts: one homed at that
// studio or holding a contact_studios row there. Anything else is the ordinary
// not-found, so ids cannot be probed. The write is the shared per-studio write
// (src/lib/studio-consent.js), the same rules as the preference centre: the
// studio row only, never contact_preferences (whose trigger fans an opt-out to
// every studio). Email marketing only.
import { NextResponse } from 'next/server'
import { getCurrentUser, hasRoleAtLocation } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { ADMIN_ROLES } from '@/lib/schemas'
import { getClientIp } from '@/lib/rate-limit'
import { StudioConsentSchema } from '@/lib/studio-consent-schema'
import { applyStudioPreferenceChange } from '@/lib/studio-consent'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = () => NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const validation = await validateBody(request, StudioConsentSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  if (!user.isMaster && !hasRoleAtLocation(user, body.location_id, ADMIN_ROLES)) return notFound()

  const db = createServerClient()
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, email, wa_phone, email_status, location_id')
    .eq('id', params.id)
    .maybeSingle()
  if (contactErr) {
    console.error('[studio-consent] contact read failed:', { contactId: params.id, message: contactErr.message })
    return NextResponse.json({ success: false, error: 'Could not read the contact' }, { status: 500 })
  }
  if (!contact) return notFound()

  if (contact.location_id !== body.location_id) {
    const { data: rel, error: relErr } = await db
      .from('contact_studios')
      .select('contact_id')
      .eq('contact_id', contact.id)
      .eq('location_id', body.location_id)
      .limit(1)
      .maybeSingle()
    if (relErr) {
      console.error('[studio-consent] contact_studios read failed:', { contactId: contact.id, message: relErr.message })
      return NextResponse.json({ success: false, error: 'Could not read the contact' }, { status: 500 })
    }
    if (!rel) return notFound()
  }

  const result = await applyStudioPreferenceChange(db, {
    contact,
    locationId: body.location_id,
    changes: { email_marketing: body.email_marketing },
    source: 'staff_studio',
    ipAddress: getClientIp(request),
    performedBy: user.id,
    reason: body.reason,
    note: body.note || null,
  })
  if (!result.ok && result.status === 404) return notFound()
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { changed: result.changed } })
}
