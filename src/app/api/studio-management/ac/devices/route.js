// /api/studio-management/ac/devices
//
//   GET  → list AC devices visible to the caller at the active
//          location, filtered by the per-staff allowlist. Master
//          sees every device at the location; manager/owner with
//          NULL allowlist sees every device; everyone else sees
//          only the devices ticked in profile_locations.ac_device_ids.
//          Live state is NOT fetched here — that's the per-device
//          /state route. The list returns the row + label + provider
//          so the panel can render one card per visible device and
//          poll each card independently.
//
//   POST → master-only: create a new ac_devices row. Body:
//          { provider, provider_device_id, label, default_mode?,
//            default_temp_c?, default_fan?, session_minutes? }.
//          The provider's credentials must already be set on the
//          location row (sensibo_api_key for sensibo, thinq_pat +
//          thinq_client_id for thinq) — the POST returns 412
//          otherwise. The provider_device_id usually comes from
//          a discovery call (/sensibo-pods or /lg-devices).
//
// Auth: studio_management permission. Master role required for
// POST (handled inline because withAuth doesn't compose
// permission + role in one shot).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { validateBody } from '@/lib/validate'
import { resolveAcAllowlist, filterAcDevices } from '@shared/permissions'

const AcDeviceCreateSchema = z.object({
  provider: z.string().optional(),
  provider_device_id: z.string().optional(),
  label: z.string().optional(),
  default_mode: z.string().optional(),
  default_temp_c: z.union([z.number(), z.string()]).optional(),
  default_fan: z.string().optional(),
  session_minutes: z.union([z.number(), z.string()]).optional(),
  device_group: z.string().nullable().optional(),
}).passthrough()

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ---- GET ----

export const GET = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, locationId }) => {
    const { data: devices, error: devErr } = await db
      .from('ac_devices')
      .select('id, location_id, label, provider, device_group, default_mode, default_temp_c, default_fan, session_minutes, external_auto_off_minutes, enabled, created_at, updated_at')
      .eq('location_id', locationId)
      .eq('enabled', true)
      // Order primarily by group so devices land in their section
      // consecutively when the UI groups by device_group. Label
      // breaks ties inside a group. NULLs sort last in PG ASC
      // ordering, which puts ungrouped devices at the bottom — the
      // panel renders those under a generic 'Other' header.
      .order('device_group', { ascending: true, nullsFirst: false })
      .order('label', { ascending: true })
    if (devErr) {
      return NextResponse.json({ success: false, error: devErr.message }, { status: 500 })
    }

    // AC-ROLE.1 — filter to what the caller may actually control:
    // per-user override → role template → code default (via resolver).
    let visible = devices || []
    if (user.role !== 'master') {
      const { data: pl } = await db
        .from('profile_locations')
        .select('role, ac_device_ids')
        .eq('profile_id', user.id)
        .eq('location_id', locationId)
        .maybeSingle()
      const role = pl?.role || user.profileRole || user.role
      const resolved = resolveAcAllowlist({
        role,
        userList: pl?.ac_device_ids ?? null,
        templateList: user?.acDeviceTemplatesByLocation?.[locationId] ?? null,
      })
      visible = filterAcDevices(resolved, visible)
    }

    return NextResponse.json({ success: true, data: visible })
  }
)

// ---- POST ----

export const POST = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, locationId, request }) => {
    if (user.role !== 'master') {
      return NextResponse.json(
        { success: false, error: 'Only master can add AC devices.' },
        { status: 403 }
      )
    }

    const validation = await validateBody(request, AcDeviceCreateSchema)
    if (!validation.ok) return validation.response
    const body = validation.data

    const provider = String(body?.provider || '').toLowerCase()
    const providerDeviceId = String(body?.provider_device_id || '').trim()
    const label = String(body?.label || '').trim()
    if (provider !== 'sensibo' && provider !== 'thinq') {
      return NextResponse.json({ success: false, error: 'provider must be "sensibo" or "thinq".' }, { status: 400 })
    }
    if (!providerDeviceId) {
      return NextResponse.json({ success: false, error: 'provider_device_id is required.' }, { status: 400 })
    }
    if (!label) {
      return NextResponse.json({ success: false, error: 'label is required.' }, { status: 400 })
    }

    // Confirm the relevant vendor credentials exist on the location.
    // A device row with no path to the vendor is useless.
    const { data: loc } = await db
      .from('locations')
      .select('sensibo_api_key, thinq_pat, thinq_client_id')
      .eq('id', locationId)
      .single()
    if (provider === 'sensibo' && !loc?.sensibo_api_key) {
      return NextResponse.json({
        success: false,
        error: 'Set the Sensibo API key on this location before adding a Sensibo device.',
        code: 'sensibo_not_configured',
      }, { status: 412 })
    }
    if (provider === 'thinq' && (!loc?.thinq_pat || !loc?.thinq_client_id)) {
      return NextResponse.json({
        success: false,
        error: 'Set the LG ThinQ PAT + client id on this location before adding a ThinQ device.',
        code: 'thinq_not_configured',
      }, { status: 412 })
    }

    const insert = {
      location_id: locationId,
      label,
      provider,
      provider_device_id: providerDeviceId,
      // Defaults: only apply if explicitly provided; otherwise the
      // table defaults kick in (cool / 22 / auto / 30 min).
      ...(body?.default_mode    ? { default_mode:    body.default_mode } : {}),
      ...(body?.default_temp_c  ? { default_temp_c:  Number(body.default_temp_c) } : {}),
      ...(body?.default_fan     ? { default_fan:     body.default_fan } : {}),
      ...(body?.session_minutes ? { session_minutes: Number(body.session_minutes) } : {}),
      // STUDIO-AC-GROUPS.1 — pre-populate device_group with the
      // same sensible defaults the mig 211 backfill used so the
      // new row lands in a group on first save. The operator
      // re-categorises from the settings UI if needed (e.g. moving
      // an LG office unit out of 'Bathrooms').
      device_group: body?.device_group
        ? String(body.device_group).trim() || null
        : (provider === 'sensibo' ? 'Gym Floor' : 'Bathrooms'),
    }

    const { data: row, error: insErr } = await db
      .from('ac_devices')
      .insert(insert)
      .select()
      .single()
    if (insErr) {
      // Unique constraint on (location_id, provider, provider_device_id):
      // surface a friendlier 409 than the raw Postgres error.
      const msg = insErr.message || ''
      if (msg.includes('ac_devices_location_id_provider_provider_device_id_key')) {
        return NextResponse.json({
          success: false,
          error: 'This device is already added to this location.',
          code: 'duplicate_device',
        }, { status: 409 })
      }
      return NextResponse.json({ success: false, error: insErr.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, data: row }, { status: 201 })
  }
)
