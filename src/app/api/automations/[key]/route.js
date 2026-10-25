// PUT /api/automations/[key] — toggle/configure a per-location automation.
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { getAutomation } from '@/lib/automations/registry'
import { SCREEN_MODE_KEY, resolveScreenConfig, PACKAGE_NAME_RE, PACKAGE_NAME_MAX } from '@/lib/screen-mode'
import { ringScreens } from '@/lib/screen-doorbell'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const Schema = z.object({
  location_id: uuidLike,
  enabled: z.boolean(),
  // W0.12 — device_ids are checked against ac_devices at location_id below;
  // the rest of the config stays free-form (each automation's own keys).
  config: z.object({ device_ids: z.array(uuidLike).max(50).optional() }).passthrough().optional(),
})

// SCREENMODE.4 — the planner only clamps a lead at zero, so cap it here: a
// lead of a million minutes would pin every screen on the class app for good.
const MAX_LEAD_MIN = 1440
const DeviceNames = z.array(z.string().min(1).max(100)).max(50).optional()

const bad = (error, status = 400) => NextResponse.json({ success: false, error }, { status })

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  // ROLESWEEP.1a — coarse pre-check only; the role is judged at
  // body.location_id below, never at the active studio (user.role).
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { key } = await params
  if (!getAutomation(key)) {
    return NextResponse.json({ success: false, error: 'unknown_automation' }, { status: 400 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, body.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  // The stored config. Only screen_mode rewrites it (see below).
  let config = body.config || {}

  // SCREENMODE.4 — screen_mode names Android TV boxes (fleet_devices rows with
  // role 'screen') by device_name, and a box acts on what is stored here, so
  // every value is checked before anything is read or written. The pure checks
  // run first: a bad value costs no query.
  let screenNames = null
  if (key === SCREEN_MODE_KEY) {
    const raw = body.config || {}

    const pkg = raw.class_app_package
    if (pkg !== undefined && pkg !== null
        && (typeof pkg !== 'string' || pkg.length > PACKAGE_NAME_MAX || !PACKAGE_NAME_RE.test(pkg))) {
      return bad('bad_package_name')
    }

    for (const lead of [raw.lead_in_min, raw.lead_out_min]) {
      if (lead !== undefined && lead !== null && Number(lead) > MAX_LEAD_MIN) return bad('bad_lead')
    }

    const names = DeviceNames.safeParse(raw.device_names)
    if (!names.success) return bad('bad_device_names')
    screenNames = [...new Set(names.data || [])]

    // Server-side enable gate (the card also gates the button): a box acts on
    // this config, so an automation cannot go live with nothing to launch or
    // nothing to launch it on. Saving it switched off stays unconstrained.
    if (body.enabled === true && (typeof pkg !== 'string' || !pkg || !screenNames.length)) {
      return bad('cannot_enable')
    }

    config = { ...resolveScreenConfig(raw), device_names: screenNames }
  }

  const db = createServerClient()

  if (screenNames?.length) {
    const { data: owned, error: fleetErr } = await db
      .from('fleet_devices')
      .select('device_name')
      .eq('location_id', body.location_id)
      .eq('role', 'screen')
      .in('device_name', screenNames)
    if (fleetErr) return NextResponse.json({ success: false, error: fleetErr.message }, { status: 500 })
    const ownedNames = new Set((owned || []).map((d) => d.device_name))
    if (screenNames.some((n) => !ownedNames.has(n))) {
      // Same rule as the AC check below: a name from another studio would let
      // this config steer THAT studio's screens. Refuse; never say which.
      return bad('unknown_device')
    }
  }

  // device_ids belong to the climate keys; screens never send them.
  const wanted = key === SCREEN_MODE_KEY ? [] : (body.config?.device_ids || [])
  if (wanted.length) {
    const { data: owned, error: devErr } = await db
      .from('ac_devices')
      .select('id')
      .eq('location_id', body.location_id)
      .in('id', wanted)
    if (devErr) return NextResponse.json({ success: false, error: devErr.message }, { status: 500 })
    const ownedIds = new Set((owned || []).map((d) => d.id))
    const foreign = wanted.filter((id) => !ownedIds.has(id))
    if (foreign.length) {
      // W0.12 — a pasted id from another studio would make the climate
      // runners switch THAT studio's AC. Refuse; never say whose it is.
      return NextResponse.json({ success: false, error: 'unknown_device' }, { status: 400 })
    }
  }

  // Boxes removed from the list must hear about it too, or they would sit on
  // the class app until their next poll. One read of the row being replaced; a
  // failed read just means no old names (the ring is best effort anyway).
  let priorNames = []
  if (screenNames) {
    const { data: prior, error: priorErr } = await db
      .from('location_automations')
      .select('config')
      .eq('location_id', body.location_id)
      .eq('automation_key', key)
      .maybeSingle()
    if (priorErr) {
      logWarn('automations', 'screen_mode prior config unreadable; ringing new names only', {
        locationId: body.location_id, error: priorErr.message,
      })
    } else if (Array.isArray(prior?.config?.device_names)) {
      priorNames = prior.config.device_names.filter((n) => typeof n === 'string' && n)
    }
  }

  const { data, error } = await db
    .from('location_automations')
    .upsert({
      location_id: body.location_id,
      automation_key: key,
      enabled: body.enabled,
      config,
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    }, { onConflict: 'location_id,automation_key' })
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // Wake the named boxes (old and new) so they re-fetch their plan now rather than at the next
  // poll. Best effort: the config is saved, so a failed ring never fails this.
  if (screenNames) {
    try {
      await ringScreens([...new Set([...priorNames, ...config.device_names])])
    } catch (err) {
      logWarn('automations', 'screen_mode doorbell failed after save', { err: String(err) })
    }
  }

  return NextResponse.json({ success: true, data })
}
