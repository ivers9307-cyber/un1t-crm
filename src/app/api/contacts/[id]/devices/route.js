// GET    /api/contacts/[id]/devices  → list contact's devices
// POST   /api/contacts/[id]/devices  → register a new device
//
// Operator-side: master / owner / manager / head_coach can manage.
// Lower roles can read but not write. Customer self-service goes
// through champ-app's /account/devices route, not here.
//
// Validation lives in src/lib/contact-devices.js (validateDeviceInput).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateDeviceInput, listForContact } from '@/lib/contact-devices'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const WRITE_ROLES = ['owner', 'manager', 'head_coach']

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const { devices, error } = await listForContact(db, params.id)
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 })
  }
  return NextResponse.json({ ok: true, devices })
}

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!user.isMaster && !WRITE_ROLES.includes(user.role)) {
    return NextResponse.json({ ok: false, error: 'Admin only' }, { status: 403 })
  }

  let body
  try { body = await request.json() } catch { body = {} }

  const valid = validateDeviceInput(body)
  if (!valid.ok) {
    return NextResponse.json({ ok: false, error: valid.error }, { status: 400 })
  }

  const db = createServerClient()

  // Confirm contact exists + caller can see its location.
  const { data: contact, error: cErr } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (cErr || !contact) {
    return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })
  }
  if (!user.isMaster) {
    const allowed = (user.locationIds || []).includes(contact.location_id)
    if (!allowed) {
      return NextResponse.json({ ok: false, error: 'Location not in your scope' }, { status: 403 })
    }
  }

  const { data, error } = await db
    .from('contact_devices')
    .insert({
      contact_id: params.id,
      ...valid.normalised,
      added_by_contact: false,
      added_by_user_id: user.id,
    })
    .select('id, device_type, identifier, label, manufacturer, is_active, added_by_contact, created_at')
    .single()

  if (error) {
    if (/duplicate key/i.test(error.message || '')) {
      return NextResponse.json({
        ok: false,
        error: 'This device is already registered to this contact.',
      }, { status: 409 })
    }
    logWarn('contact-devices', 'insert failed', { err: error })
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 })
  }

  logInfo('contact-devices', 'device registered (operator)', {
    contactId: params.id, deviceId: data.id, identifier: data.identifier, actor: user.id,
  })

  return NextResponse.json({ ok: true, device: data }, { status: 201 })
}
