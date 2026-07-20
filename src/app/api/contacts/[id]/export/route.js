// SAAS4-C3 — subject-access (DSAR) export for one contact.
//
// GET returns the full JSON bundle of everything held about a member
// (profile, preferences, consent log with its evidentiary trail,
// email/booking/activity/note history, WhatsApp + Instagram messages)
// as a download. Pairs with the existing erasure path (DELETE
// /api/contacts/[id], hard delete + redaction) to complete the
// data-subject rights surface the gyms answer to as controllers.
//
// Auth mirrors the contact DELETE: cookie session, MANAGER_ROLES,
// location-scoped, 404-not-403 on cross-tenant ids. Every export is
// audit-logged — handing over a member's full record is itself a
// privacy-relevant act.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { buildContactExport } from '@/lib/contact-export'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: contact } = await db
    .from('contacts')
    .select('id, name, email, phone, created_at, location_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!contact) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard

  let bundle
  try {
    bundle = await buildContactExport(db, contact)
  } catch (e) {
    // An incomplete DSAR bundle must fail loudly, never ship with a
    // silently missing section.
    return NextResponse.json({ success: false, error: `Export failed: ${e.message}` }, { status: 500 })
  }

  await logAuditEvent({
    category: 'privacy',
    action: 'contact_export',
    actor: user,
    target: { resource: `contacts/${contact.id}`, label: contact.name || contact.email || contact.id },
    locationId: contact.location_id,
    request,
  })

  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="contact-export-${contact.id}.json"`,
      'Cache-Control': 'no-store',
    },
  })
}
