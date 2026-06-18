// src/app/api/live/[locationId]/register-device/route.js
//
// POST   /api/live/[locationId]/register-device  → permanent contact_devices registration
// DELETE /api/live/[locationId]/register-device  → deactivate (unregister)
//
// HR-DETECT.1 — "Remember this device" from the coach Detected tab. Registering a
// strap to a member means it auto-routes to their session every future class
// (contact_devices is the auto path in resolveStrapsForBatch). Coach-role gated,
// same as /pair. (Per-class "pair for today" reuses the existing /pair route.)

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { canonicaliseDeviceKey } from '@/lib/bridge-samples'
import { logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['owner', 'manager', 'head_coach', 'coach']

function guard(user, locationId) {
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (!user.isMaster && !ALLOWED_ROLES.includes(user.role)) {
    return NextResponse.json({ ok: false, error: 'Coach only' }, { status: 403 })
  }
  if (!user.isMaster && !getUserLocationIds(user).includes(locationId)) {
    return NextResponse.json({ ok: false, error: 'Location not in your scope' }, { status: 403 })
  }
  return null
}

const RegisterSchema = z.object({
  device_key: z.string().min(1),
  contact_id: uuidLike,
  device_type: z.enum(['chest_strap', 'watch']).optional(),
  label: z.string().max(80).optional(),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const denied = guard(user, params.locationId)
  if (denied) return denied

  const validation = await validateBody(request, RegisterSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const deviceKey = canonicaliseDeviceKey(body.device_key)
  if (!deviceKey) return NextResponse.json({ ok: false, error: 'Invalid device_key' }, { status: 400 })

  const db = createServerClient()
  // IDOR guard: the contact must belong to this location.
  const { data: contact } = await db.from('contacts').select('id, location_id').eq('id', body.contact_id).maybeSingle()
  if (!contact || contact.location_id !== params.locationId) {
    return NextResponse.json({ ok: false, error: 'Contact not at this location' }, { status: 404 })
  }

  const deviceType = body.device_type || 'chest_strap'
  const { data, error } = await db
    .from('contact_devices')
    .upsert({
      contact_id: body.contact_id,
      device_type: deviceType,
      identifier: deviceKey,
      label: body.label || null,
      is_active: true,
      added_by_contact: false,
      added_by_user_id: user.id,
    }, { onConflict: 'contact_id,device_type,identifier' })
    .select('id')
    .single()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 })

  logInfo('hr-detect', 'register device', { locationId: params.locationId, contactId: body.contact_id, deviceKey, deviceType, actor: user.id })
  return NextResponse.json({ ok: true, device_id: data.id })
}

const UnregisterSchema = z.object({
  device_key: z.string().min(1),
  contact_id: uuidLike,
})

export async function DELETE(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const denied = guard(user, params.locationId)
  if (denied) return denied

  const validation = await validateBody(request, UnregisterSchema)
  if (!validation.ok) return validation.response
  const deviceKey = canonicaliseDeviceKey(validation.data.device_key)
  if (!deviceKey) return NextResponse.json({ ok: false, error: 'Invalid device_key' }, { status: 400 })

  const db = createServerClient()
  // IDOR guard: the contact must belong to this location (mirror POST).
  const { data: contact } = await db.from('contacts').select('id, location_id').eq('id', validation.data.contact_id).maybeSingle()
  if (!contact || contact.location_id !== params.locationId) {
    return NextResponse.json({ ok: false, error: 'Contact not at this location' }, { status: 404 })
  }

  const { error } = await db
    .from('contact_devices')
    .update({ is_active: false })
    .eq('contact_id', validation.data.contact_id)
    .eq('identifier', deviceKey)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 })

  return NextResponse.json({ ok: true })
}
