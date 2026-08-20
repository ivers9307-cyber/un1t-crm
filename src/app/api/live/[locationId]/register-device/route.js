// src/app/api/live/[locationId]/register-device/route.js
//
// POST   /api/live/[locationId]/register-device  → permanent contact_devices registration
// DELETE /api/live/[locationId]/register-device  → deactivate (unregister)
//
// HR-DETECT.1 — "Remember this device" from the coach Detected tab. Registering a
// strap to a member means it auto-routes to their session every future class
// (contact_devices is the auto path in resolveStrapsForBatch). Coach-role gated,
// same as /pair. (Per-class "pair for today" reuses the existing /pair route.)
//
// HR-CLAIM.1 — the one-tap "Claim" flow lands here too, adding:
//   - a steal guard: 409 if the strap is actively registered to ANOTHER contact
//     (unregister from their profile first — never silently reassign hardware)
//   - open-session adoption: if the strap has an OPEN contact-less session at
//     this location (the anon walk-in path), stamp contact_id on it so the
//     member gets TODAY's class, not just future ones. Mirrors the pairOverride
//     adopt branch (src/lib/live-class.js) incl. its mig 343 race handling.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { guardLiveLocation, LIVE_MUTATION_ROLES } from '@/lib/live-access'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { canonicaliseDeviceKey } from '@/lib/bridge-samples'
import { findRegistrationConflict, planAnonAdoption } from '@/lib/hr-claim'
import { resolveMaxHr } from '@/lib/heart-rate'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// SEC-LIVE-API.1 — coach role at the location AND `studio_management` there.
function guard(user, locationId) {
  return guardLiveLocation(user, locationId, { roles: LIVE_MUTATION_ROLES })
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
  // IDOR guard: the contact must belong to this location. (max_hr_override/dob
  // feed the adoption re-stamp below, mirroring pairOverride.)
  const { data: contact } = await db.from('contacts').select('id, location_id, max_hr_override, dob').eq('id', body.contact_id).maybeSingle()
  if (!contact || contact.location_id !== params.locationId) {
    return NextResponse.json({ ok: false, error: 'Contact not at this location' }, { status: 404 })
  }

  // Steal guard: refuse if the strap is actively registered to a DIFFERENT
  // contact — any location (it's one member's hardware), but the holder's name
  // is only shown when they're at THIS location (no cross-tenant name leak).
  const { data: existingRegs, error: regErr } = await db
    .from('contact_devices')
    .select('contact_id, is_active, contacts(name, location_id)')
    .eq('identifier', deviceKey)
    .eq('is_active', true)
  if (regErr) return NextResponse.json({ ok: false, error: regErr.message }, { status: 400 })
  const conflict = findRegistrationConflict({
    deviceRows: existingRegs || [], contactId: body.contact_id, locationId: params.locationId,
  })
  if (conflict) {
    return NextResponse.json({
      ok: false,
      error: conflict.name
        ? `This strap is already registered to ${conflict.name}. Unregister it from their profile first.`
        : 'This strap is already registered to another member.',
    }, { status: 409 })
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

  // Open-session adoption (HR-CLAIM.1) — best-effort, never fails the
  // registration. Only the currently-OPEN contact-less session for this strap
  // is eligible, and only when the member has no open session of their own
  // (mig 343: one open row per member/location). The update re-pins the anon
  // filters so a racing bridge batch can't make us steal a session that just
  // gained a contact; a 23505 from the member index simply skips adoption.
  let adoptedSessionId = null
  try {
    const [{ data: memberOpen }, { data: anon }] = await Promise.all([
      db.from('heart_rate_sessions')
        .select('id')
        .eq('contact_id', body.contact_id)
        .eq('location_id', params.locationId)
        .is('ended_at', null)
        .limit(1)
        .maybeSingle(),
      db.from('heart_rate_sessions')
        .select('id, contact_id, ended_at')
        .eq('location_id', params.locationId)
        .eq('device_identifier', deviceKey)
        .is('contact_id', null)
        .is('ended_at', null)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])
    const plan = planAnonAdoption({ anonSession: anon, memberOpenSessionId: memberOpen?.id ?? null })
    if (plan.adoptId) {
      const { error: adoptErr } = await db
        .from('heart_rate_sessions')
        .update({ contact_id: body.contact_id, max_hr_used: resolveMaxHr(contact) })
        .eq('id', plan.adoptId)
        .eq('location_id', params.locationId)
        .is('contact_id', null)
        .is('ended_at', null)
      if (adoptErr) {
        if (adoptErr.code !== '23505') logWarn('hr-detect', 'session adoption failed', { err: adoptErr, deviceKey })
      } else {
        adoptedSessionId = plan.adoptId
      }
    }
  } catch (e) {
    logWarn('hr-detect', 'session adoption threw', { err: e?.message, deviceKey })
  }

  logInfo('hr-detect', 'register device', { locationId: params.locationId, contactId: body.contact_id, deviceKey, deviceType, adoptedSessionId, actor: user.id })
  return NextResponse.json({ ok: true, device_id: data.id, adopted_session_id: adoptedSessionId })
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
