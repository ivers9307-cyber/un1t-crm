// POST /api/contacts/[id]/push-to-glofox  (GLOFOX3.4)
//
// Manual operator-triggered CRM → Glofox push. Wraps the
// findOrCreateGlofoxMember orchestrator with source='manual_button'.
//
// Pre-flight validates first_name + last_name + email all present;
// Glofox /2.0/register insists on all three and we don't want to
// guess (the booking + event flows fall back to splitting `name`
// because the public form is single-name-field; here the operator
// can fix the contact first and retry).
//
// Auth: manager+ at the contact's location (same surface as the
// edit + delete buttons that sit next to this one on the page).
//
// Returns the orchestrator's full result so the client can render
// the right feedback (created vs linked vs needs_review vs failed).
// On linked/created we revalidate the contact page in the response
// so the next render shows the freshly-populated Glofox card.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({
      success: false,
      error: 'Head coach, manager, owner, or master required',
    }, { status: 403 })
  }

  const { id } = await params
  if (!id) {
    return NextResponse.json({ success: false, error: 'missing contact id' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: contact, error } = await db
    .from('contacts')
    .select('id, name, email, first_name, last_name, phone, dob, location_id, glofox_member_id')
    .eq('id', id)
    .single()
  if (error || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  // Tenant guard — non-master users must own the contact's location.
  if (user.role !== 'master') {
    const userLocIds = (user.locations || []).map((l) => l.id)
    if (!userLocIds.includes(contact.location_id)) {
      return NextResponse.json({
        success: false,
        error: 'Contact is at a different location',
      }, { status: 403 })
    }
  }

  if (contact.glofox_member_id) {
    return NextResponse.json({
      success: false,
      error: 'already_linked',
      message: 'Contact is already linked to Glofox. Use the Glofox profile section to view their record.',
      glofox_member_id: contact.glofox_member_id,
    }, { status: 409 })
  }

  // Pre-flight: Glofox /2.0/register insists on first_name + last_name + email.
  const missing = []
  if (!contact.first_name) missing.push('first_name')
  if (!contact.last_name) missing.push('last_name')
  if (!contact.email) missing.push('email')
  if (missing.length > 0) {
    return NextResponse.json({
      success: false,
      error: 'missing_required_fields',
      message: `Fill in ${missing.join(', ')} on the contact before pushing to Glofox.`,
      missing,
    }, { status: 400 })
  }

  const result = await findOrCreateGlofoxMember({
    db,
    locationId: contact.location_id,
    contact,
    source: 'manual_button',
    createIfMissing: true,
    attachTrial: true,
  })

  const httpStatus = (result.status === 'failed') ? 502 : 200
  return NextResponse.json({
    success: result.status !== 'failed',
    result,
  }, { status: httpStatus })
}
