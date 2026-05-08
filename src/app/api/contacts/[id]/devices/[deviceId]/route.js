// DELETE /api/contacts/[id]/devices/[deviceId]
//   Operator removes a device from a contact's profile. The strap
//   stops auto-routing immediately on the next bridge sample.
//
// PATCH /api/contacts/[id]/devices/[deviceId]
//   Toggle is_active or update label. Same role gate as POST.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const WRITE_ROLES = ['owner', 'manager', 'head_coach']

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!user.isMaster && !WRITE_ROLES.includes(user.role)) {
    return NextResponse.json({ ok: false, error: 'Admin only' }, { status: 403 })
  }

  const db = createServerClient()
  const { error } = await db
    .from('contact_devices')
    .delete()
    .eq('id', params.deviceId)
    .eq('contact_id', params.id)
  if (error) {
    logWarn('contact-devices', 'delete failed', { err: error })
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 })
  }
  logInfo('contact-devices', 'device deleted (operator)', {
    contactId: params.id, deviceId: params.deviceId, actor: user.id,
  })
  return NextResponse.json({ ok: true })
}

export async function PATCH(request, { params }) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!user.isMaster && !WRITE_ROLES.includes(user.role)) {
    return NextResponse.json({ ok: false, error: 'Admin only' }, { status: 403 })
  }

  let body
  try { body = await request.json() } catch { body = {} }

  const updates = {}
  if (typeof body.is_active === 'boolean') updates.is_active = body.is_active
  if (body.label != null) updates.label = String(body.label).trim().slice(0, 80) || null
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: false, error: 'No valid updates' }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('contact_devices')
    .update(updates)
    .eq('id', params.deviceId)
    .eq('contact_id', params.id)
    .select('id, device_type, identifier, label, manufacturer, is_active, added_by_contact, created_at')
    .single()
  if (error || !data) {
    logWarn('contact-devices', 'update failed', { err: error })
    return NextResponse.json({ ok: false, error: error?.message || 'Update failed' }, { status: 400 })
  }
  return NextResponse.json({ ok: true, device: data })
}
