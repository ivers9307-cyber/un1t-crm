// POST /api/contacts/[id]/inbody-sync
//
// Operator clicks "Sync InBody" on a contact → queue a backfill request. The
// on-site Pi (the only thing that can call the IP-whitelisted Lookin'Body API)
// picks it up (GET /api/bridge/inbody/backfill-pending), pulls every scan for
// this member's phone, and lands them in inbody_scans. The scans then render in
// the contact's InBody charts.
//
// Permission: `consultations` (same gate as the InBody section on the contact
// page). Service-role route, so the permission check IS the access gate.

import { NextResponse } from 'next/server'
import { getUserLocationIds } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ROLESWEEP.1c — coarse pre-check (`consultations` somewhere, the same 'Not
// permitted' 403); judged at the contact's location below. A signed-out call is
// withAuth's 401 'Unauthorized' (it said 'Unauthorised').
export const POST = withAuth({
  permission: null, location: false,
  allow: (user) => hasPermissionAtAnyLocation(user, 'consultations'), forbiddenMessage: 'Not permitted',
}, async ({ user, db, params }) => {
  const { data: contact, error: lookupErr } = await db
    .from('contacts')
    .select('id, phone, wa_phone, location_id')
    .eq('id', params.id)
    .single()
  if (lookupErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  if (!user.isMaster && !getUserLocationIds(user).includes(contact.location_id)) {
    return NextResponse.json({ success: false, error: 'Location not in your scope' }, { status: 403 })
  }
  // ROLESWEEP.1c — `consultations` judged at the contact's location.
  if (!hasPermissionForLocation(user, contact.location_id, 'consultations')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const phone = contact.phone || contact.wa_phone
  if (!phone) {
    return NextResponse.json({
      success: false,
      error: 'Contact has no phone on file — InBody scans are matched by phone number.',
    }, { status: 400 })
  }

  const { data: req, error: insertErr } = await db
    .from('inbody_backfill_requests')
    .insert({
      contact_id: contact.id,
      phone,
      location_id: contact.location_id,
      requested_by: user.id,
      status: 'pending',
    })
    .select('id, status')
    .single()
  if (insertErr) {
    logError('inbody-sync', 'backfill request insert failed', { contactId: contact.id, err: insertErr })
    return NextResponse.json({ success: false, error: 'Could not queue the InBody sync. Try again.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { request_id: req.id, status: req.status } })
})
