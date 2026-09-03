// GET/PUT /api/locations/[id]/geofence-attendance
//
// GEO-ATT.5 — read + write the per-location mobile geofence attendance
// config (locations.settings.geofence, mig 463):
//   { enabled, latitude, longitude, radius_m, gate_copy }
// OFF by default. When enabled (with real coordinates), the CRM mobile
// app gates staff behind a background-location permission screen and
// auto-stamps shift arrivals via /api/attendance/geofence-checkin.
// Normalisation/defaults live in src/lib/geofence-attendance.js.
//
// Auth mirrors comms-frequency-cap: any authenticated user at the
// location can READ; owner + master AT THE TARGET LOCATION write (the gate
// blocks every staff phone at the location — an operator-level knob).
//
// MAILFIX-BRANDGATE.2 — the role is judged AT params.id, never via
// `user.role`. That field resolves at the caller's ACTIVE location (with a
// highest-role-anywhere fallback in auth.js), while this write lands on the
// path-param location — so the old `user.role === 'owner'` check let an
// owner at studio A who is plain STAFF at studio B PUT
// /api/locations/<B>/geofence-attendance and put a geofence over B's staff
// with a 200. Same shape and order as the #1586 branding routes /
// guardMailboxAdmin: membership first (assertLocationAccess —
// guardMasterOrOwner never checks membership, a master belongs nowhere), so
// an owner of a DIFFERENT studio is told "not one of your locations" rather
// than a role complaint that confirms the studio exists; then owner-or-master
// at the target. Both run before the row is fetched, so a non-member never
// reaches the database. Role miss keeps this route's own copy over the
// guard's generic one.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import {
  geofenceFromLocationSettings,
  GEOFENCE_MIN_RADIUS_M,
  GEOFENCE_MAX_RADIUS_M,
} from '@/lib/geofence-attendance'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const GeofenceSettingsSchema = z.object({
  enabled: z.boolean(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  radius_m: z.number().int().min(GEOFENCE_MIN_RADIUS_M).max(GEOFENCE_MAX_RADIUS_M),
  gate_copy: z.string().max(2000).nullable(),
}).refine(v => !v.enabled || (v.latitude !== null && v.longitude !== null), {
  message: 'Latitude and longitude are required when geofencing is enabled',
})

// Thin wrapper over the REAL guard, so GET's `can_edit` and PUT's gate cannot
// drift apart: the card never offers a Save the server will refuse, and never
// hides the editor from the target studio's actual owner. No second role
// predicate lives in this file.
function canEditGeofence(user, locationId) {
  if (!user) return false
  return guardMasterOrOwner(user, locationId) === null
}

function shape(settings, canEdit) {
  const g = geofenceFromLocationSettings(settings)
  return {
    enabled: g.enabled,
    latitude: g.latitude,
    longitude: g.longitude,
    radius_m: g.radiusM,
    gate_copy: g.gateCopy,
    can_edit: canEdit,
  }
}

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: location, error } = await db
    .from('locations')
    .select('id, settings')
    .eq('id', params.id)
    .single()
  if (error || !location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, location.id)
  if (guard) return guard

  return NextResponse.json({
    success: true,
    data: shape(location.settings, canEditGeofence(user, location.id)),
  })
}

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Target FIRST — the id is already on the path — then membership, then the
  // role AT THAT TARGET (see the header for why not `user.role`). Both gates
  // precede validation and the row fetch, so a refused caller learns nothing
  // about the schema and a non-member cannot tell 403 from 404.
  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canEditGeofence(user, locationId)) {
    return NextResponse.json({
      success: false,
      error: 'Only owners and masters can edit geofence attendance.',
    }, { status: 403 })
  }

  const validation = await validateBody(request, GeofenceSettingsSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // The row is read for the MERGE below; membership was already judged on
  // the same id above (the query pins `id = locationId`), so no second check.
  const db = createServerClient()
  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, settings')
    .eq('id', locationId)
    .single()
  if (locErr || !location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }

  // Merge — never clobber sibling settings keys (glofox, webhooks, …).
  const updatedSettings = {
    ...(location.settings || {}),
    geofence: {
      enabled: body.enabled,
      latitude: body.latitude,
      longitude: body.longitude,
      radius_m: body.radius_m,
      gate_copy: body.gate_copy,
    },
  }

  const { data, error } = await db
    .from('locations')
    .update({ settings: updatedSettings, updated_at: new Date().toISOString() })
    .eq('id', locationId)
    .select('id, settings')
    .single()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: shape(data.settings, true) })
}
