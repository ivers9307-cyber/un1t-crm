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
// location can READ; owner + master WRITE (the gate blocks every staff
// phone at the location — an operator-level knob).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
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

function canEditGeofence(user) {
  if (!user) return false
  if (user.isMaster || user.role === 'master') return true
  return user.role === 'owner'
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
    data: shape(location.settings, canEditGeofence(user)),
  })
}

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canEditGeofence(user)) {
    return NextResponse.json({
      success: false,
      error: 'Only owners and masters can edit geofence attendance.',
    }, { status: 403 })
  }

  const validation = await validateBody(request, GeofenceSettingsSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, settings')
    .eq('id', params.id)
    .single()
  if (locErr || !location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, location.id)
  if (guard) return guard

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
    .eq('id', params.id)
    .select('id, settings')
    .single()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: shape(data.settings, true) })
}
