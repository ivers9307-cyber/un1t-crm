// DELETE /api/contacts/[id]/devices/[deviceId]
//   Operator removes a device from a contact's profile. The strap
//   stops auto-routing immediately on the next bridge sample.
//
// PATCH /api/contacts/[id]/devices/[deviceId]
//   Toggle is_active or update label. Same role gate as POST.
//
// SECFIX.1 — both handlers read the contact, 404 a non-member, and judge the
// write role at the CONTACT's location (see gateContact).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getPersonGroup } from '@/lib/person-links'
import { logInfo, logWarn } from '@/lib/log'
import { validateBody } from '@/lib/validate'

const PatchDeviceBody = z.object({
  is_active: z.boolean().optional(),
  label: z.string().max(80).nullable().optional(),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const WRITE_ROLES = ['owner', 'manager', 'head_coach']

// SECFIX.1 (security) — neither handler read the contact or checked the
// caller belongs to its location, and the only gate was the role at the
// caller's ACTIVE studio: any owner/manager/head coach ANYWHERE could delete
// or relabel a strap on any contact estate-wide by id. Resolve the contact,
// 404 a non-member (detail route: ids stay non-enumerable), then judge
// WRITE_ROLES at the contact's location. Masters are exempt from both, as on
// the sibling GET / POST in ../route.js.
//
// ONE 404 body for "no such contact" and "a contact at a studio you are not
// in": assertLocationAccessOr404's own body ({ success:false, error:'Not
// found' }) differed from the missing-contact body, so the shape alone told a
// caller the id exists elsewhere. The route's `{ ok:false }` shape is kept —
// it is what ContactDevicesCard reads (`data.ok` / `data.error`).
const contactNotFound = () => NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })

async function gateContact(db, user, contactId) {
  const { data: contact, error } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', contactId)
    .single()
  if (error || !contact) return contactNotFound()
  if (user.isMaster) return null
  if (assertLocationAccessOr404(user, contact.location_id)) return contactNotFound()
  if (!hasRoleAtLocation(user, contact.location_id, WRITE_ROLES)) {
    return NextResponse.json({ ok: false, error: 'Admin only' }, { status: 403 })
  }
  return null
}

export async function DELETE(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  // Coarse pre-check only; the role is judged at the contact's location in gateContact.
  if (!user.isMaster && !hasRoleAtAnyLocation(user, WRITE_ROLES)) {
    return NextResponse.json({ ok: false, error: 'Admin only' }, { status: 403 })
  }

  const db = createServerClient()
  const denied = await gateContact(db, user, params.id)
  if (denied) return denied
  // Scope the delete to all contacts in the person group so an operator
  // can remove a device that belongs to a linked profile.
  const group = await getPersonGroup(db, params.id)
  const ids = group?.members?.length ? group.members.map((m) => m.contact_id) : [params.id]

  const { error } = await db
    .from('contact_devices')
    .delete()
    .eq('id', params.deviceId)
    .in('contact_id', ids)
  if (error) {
    logWarn('contact-devices', 'delete failed', { err: error })
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 })
  }
  logInfo('contact-devices', 'device deleted (operator)', {
    contactId: params.id, deviceId: params.deviceId, actor: user.id,
  })
  return NextResponse.json({ ok: true })
}

export async function PATCH(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  // Coarse pre-check only; the role is judged at the contact's location in gateContact.
  if (!user.isMaster && !hasRoleAtAnyLocation(user, WRITE_ROLES)) {
    return NextResponse.json({ ok: false, error: 'Admin only' }, { status: 403 })
  }

  const validation = await validateBody(request, PatchDeviceBody, { allowEmpty: true })
  if (!validation.ok) return validation.response
  const body = validation.data

  const updates = {}
  if (typeof body.is_active === 'boolean') updates.is_active = body.is_active
  if (body.label != null) updates.label = String(body.label).trim().slice(0, 80) || null
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: false, error: 'No valid updates' }, { status: 400 })
  }

  const db = createServerClient()
  const denied = await gateContact(db, user, params.id)
  if (denied) return denied
  // Scope the patch to all contacts in the person group so an operator
  // can update a device that belongs to a linked profile.
  const group = await getPersonGroup(db, params.id)
  const ids = group?.members?.length ? group.members.map((m) => m.contact_id) : [params.id]

  const { data, error } = await db
    .from('contact_devices')
    .update(updates)
    .eq('id', params.deviceId)
    .in('contact_id', ids)
    .select('id, device_type, identifier, label, manufacturer, is_active, added_by_contact, created_at')
    .single()
  if (error || !data) {
    logWarn('contact-devices', 'update failed', { err: error })
    return NextResponse.json({ ok: false, error: error?.message || 'Update failed' }, { status: 400 })
  }
  return NextResponse.json({ ok: true, device: data })
}
