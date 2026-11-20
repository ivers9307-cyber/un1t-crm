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
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { buildContactExport } from '@/lib/contact-export'
import { logAuditEvent } from '@/lib/audit'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  // ROLESWEEP.1c — coarse pre-check; the role is judged at the contact's location below.
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
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
  // ROLESWEEP.1c — MANAGER_ROLES at the contact's location.
  if (!hasRoleAtLocation(user, contact.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  let bundle
  try {
    bundle = await buildContactExport(db, contact)
  } catch (e) {
    // An incomplete DSAR bundle must fail loudly, never ship with a
    // silently missing section. The detail goes to the log, not the response.
    logError('contact-export', 'export bundle failed', { contactId: contact.id, err: e })
    return NextResponse.json({ success: false, error: 'Export failed. Try again.' }, { status: 500 })
  }

  // AUDITEXPORT.1 (October audit A20) — this used to log category 'privacy',
  // which audit_events' CHECK (mig 180: auth, business, mutation, assignment)
  // refuses, and it ignored the refusal: no single-contact export was ever
  // recorded. Same contract as the bulk export (CONTACTEXPORT.1): a supported
  // category, written BEFORE the file leaves, and no file without the record.
  const audit = await logAuditEvent({
    category: 'business',
    action: 'contact_export',
    actor: user,
    target: { resource: `contacts/${contact.id}`, label: contact.name || contact.email || contact.id },
    locationId: contact.location_id,
    request,
  })
  if (!audit?.logged) {
    logError('contact-export', 'audit write failed; export withheld', { contactId: contact.id })
    return NextResponse.json({ success: false, error: 'Could not record this export, so it was not sent. Try again.' }, { status: 503 })
  }

  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="contact-export-${contact.id}.json"`,
      'Cache-Control': 'no-store',
    },
  })
}
