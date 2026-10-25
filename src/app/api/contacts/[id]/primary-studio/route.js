// POST /api/contacts/[id]/primary-studio — ORGCONTACTS.4 (decision 4, spec §5).
//
// Moves a contact's PRIMARY studio (contacts.location_id) to another studio
// the person has a relationship with, inside the contact's organisation. The
// primary studio is where the contact-wide columns follow (the pipeline board
// the classifier reads, the lead source), so changing it is the primary
// studio's admins' call, an organisation admin's, or a master's — the same
// gate as DELETE. Body: { location_id }.
//
//   401 signed out · 404 no such contact, or one the caller cannot view (never
//   403: ids cannot be enumerated) · 403 the gate · 400 validation,
//   'no_relationship' (no contact_studios row at the target),
//   'other_organisation' (the target studio is not in the contact's
//   organisation, or unknown), 'studio_inactive' (a deactivated studio or a
//   host anchor: never a primary studio, Review Focus 1) · 503 the rows read
//   failed · 200 { location_id }.
//
// The write is contacts.location_id only: mig 712's trigger keeps
// organization_id in step, the audit trigger logs it, and the target already
// holds a contact_studios row (the gate refused otherwise), so no row is
// minted here. Moving to the current primary is a no-op 200.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { canViewContact } from '@/lib/contact-crossovers'
import { canDeleteOrRehomeContact } from '@/lib/contact-edit-gates'
import { hasRelationshipAt } from '@/lib/contact-studios'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const PrimaryStudioBodySchema = z.object({ location_id: uuidLike })

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: contact } = await db
    .from('contacts')
    .select('id, location_id, organization_id')
    .eq('id', params.id)
    .single()
  if (!contact) return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 })
  if (!(await canViewContact(db, user, contact))) {
    return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 })
  }

  const validation = await validateBody(request, PrimaryStudioBodySchema)
  if (!validation.ok) return validation.response
  const target = validation.data.location_id

  if (!canDeleteOrRehomeContact({ user, contact })) {
    return NextResponse.json({ success: false, error: 'Head coach, manager, owner, or master at the contact’s primary studio, or an organisation admin, required' }, { status: 403 })
  }
  if (target === contact.location_id) {
    return NextResponse.json({ success: true, data: { location_id: contact.location_id } })
  }

  const { data: studio } = await db.from('locations').select('id, organization_id, active, is_host_anchor').eq('id', target).maybeSingle()
  if (!studio || !contact.organization_id || studio.organization_id !== contact.organization_id) {
    return NextResponse.json({ success: false, error: 'other_organisation' }, { status: 400 })
  }
  if (studio.active === false || studio.is_host_anchor === true) {
    return NextResponse.json({ success: false, error: 'studio_inactive' }, { status: 400 })
  }

  const rel = await hasRelationshipAt(db, contact.id, [target])
  if (!rel.ok) {
    logError('contacts.primary-studio', 'relationship read failed; nothing changed', { contactId: contact.id, error: rel.error })
    return NextResponse.json({ success: false, error: 'Could not read the contact’s studios just now; nothing was changed. Try again.' }, { status: 503 })
  }
  if (!rel.at.has(target)) {
    return NextResponse.json({ success: false, error: 'no_relationship' }, { status: 400 })
  }

  const { data: rows, error } = await db
    .from('contacts')
    .update({ location_id: target })
    .eq('id', contact.id)
    .select('id')
  if (error) {
    logError('contacts.primary-studio', 'write failed', { contactId: contact.id, err: error.message })
    return NextResponse.json({ success: false, error: 'Could not change the primary studio' }, { status: 500 })
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 })
  }
  return NextResponse.json({ success: true, data: { location_id: target } })
}
