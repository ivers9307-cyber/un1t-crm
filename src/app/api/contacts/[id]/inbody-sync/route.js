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
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!hasPermission(user, 'consultations')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const db = createServerClient()
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
    return NextResponse.json({ success: false, error: insertErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { request_id: req.id, status: req.status } })
}
