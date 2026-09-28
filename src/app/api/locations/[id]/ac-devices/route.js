// /api/locations/[id]/ac-devices — the AC units at the location in the PATH.
//
//   GET   master, or an owner AT [id]. Enabled units by default (the
//         StaffForm / Roles AC allowlist picker, AC-ROLE.1);
//         ?include_disabled=1 adds disabled ones (the settings tab, so a
//         disabled unit can be re-enabled). Unit config only; no credential
//         lives on ac_devices.
//   POST  master only: add a unit at [id]. Body { provider,
//         provider_device_id, label, default_mode?, default_temp_c?,
//         default_fan?, session_minutes?, device_group? }. 412 when [id] has
//         no credentials for that vendor; 409 when the unit is already there.
//
// ACDEVLOC.1 — the settings tab used to list and add through
// /api/studio-management/ac/devices, which acts on the caller's ACTIVE studio,
// while the tab lives on /settings/locations/<id>: a master on Hatch's tab
// with Stillorgan active saw, and added to, Stillorgan. Every decision here is
// made at params.id: membership first (404 for a location the caller does not
// belong to, so the id is not confirmed), then the role at that location.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { logError } from '@/lib/log'
import { buildDeviceInsert, readAcCredentials } from '@/lib/ac-device-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CreateBody = z.object({
  provider: z.string().max(20),
  provider_device_id: z.string().max(200),
  label: z.string().max(120),
  default_mode: z.string().max(20).optional(),
  default_temp_c: z.union([z.number(), z.string()]).optional(),
  default_fan: z.string().max(20).optional(),
  session_minutes: z.union([z.number(), z.string()]).optional(),
  device_group: z.string().max(120).nullable().optional(),
})

async function pathLocation(props) {
  const params = await props.params
  return params?.id || null
}

export async function GET(request, props) {
  const locationId = await pathLocation(props)
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!locationId) return NextResponse.json({ success: false, error: 'Location id required.' }, { status: 400 })
  const notMember = assertLocationAccessOr404(user, locationId)
  if (notMember) return notMember
  const notOwner = guardMasterOrOwner(user, locationId)
  if (notOwner) return notOwner

  const includeDisabled = new URL(request.url).searchParams.get('include_disabled') === '1'
  const db = createServerClient()
  let query = db
    .from('ac_devices')
    .select('id, location_id, label, provider, device_group, default_mode, default_temp_c, default_fan, session_minutes, external_auto_off_minutes, enabled, created_at, updated_at')
    .eq('location_id', locationId)
  if (!includeDisabled) query = query.eq('enabled', true)
  const { data, error } = await query.order('label', { ascending: true })
  if (error) {
    logError('ac-devices', 'list read failed', { locationId, err: error.message })
    return NextResponse.json({ success: false, error: 'Could not load AC devices.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, devices: data || [] })
}

export async function POST(request, props) {
  const locationId = await pathLocation(props)
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!locationId) return NextResponse.json({ success: false, error: 'Location id required.' }, { status: 400 })
  const notMember = assertLocationAccessOr404(user, locationId)
  if (notMember) return notMember
  if (!user.isMaster) {
    return NextResponse.json({ success: false, error: 'Only master can add AC devices.' }, { status: 403 })
  }

  const parsed = await validateBody(request, CreateBody)
  if (!parsed.ok) return parsed.response
  const built = buildDeviceInsert(locationId, parsed.data)
  if (built.error) return NextResponse.json({ success: false, error: built.error }, { status: 400 })
  const { insert } = built

  // A unit with no path to its vendor is useless: the credentials must be
  // saved on THIS location first. A failed read is not "not configured".
  const db = createServerClient()
  const read = await readAcCredentials(db, locationId)
  if (read.error) {
    logError('ac-devices', 'credentials read failed', { locationId, err: read.error.message })
    return NextResponse.json({
      success: false,
      error: "Could not read this location's AC credentials, so nothing was added. Try again.",
    }, { status: 500 })
  }
  if (read.notFound) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (insert.provider === 'sensibo' && !read.creds.sensiboApiKey) {
    return NextResponse.json({
      success: false,
      error: 'Save the Sensibo API key on this location before adding a Sensibo device.',
      code: 'sensibo_not_configured',
    }, { status: 412 })
  }
  if (insert.provider === 'thinq' && (!read.creds.thinqPat || !read.creds.thinqClientId)) {
    return NextResponse.json({
      success: false,
      error: 'Save the LG ThinQ PAT on this location before adding a ThinQ device.',
      code: 'thinq_not_configured',
    }, { status: 412 })
  }

  const { data: device, error: insErr } = await db
    .from('ac_devices')
    .insert(insert)
    .select('id, location_id, label, provider, device_group, default_mode, default_temp_c, default_fan, session_minutes, external_auto_off_minutes, enabled, created_at, updated_at')
    .single()
  if (insErr) {
    // UNIQUE (location_id, provider, provider_device_id).
    if (insErr.code === '23505' || String(insErr.message || '').includes('ac_devices_location_id_provider_provider_device_id_key')) {
      return NextResponse.json({
        success: false,
        error: 'This device is already added to this location.',
        code: 'duplicate_device',
      }, { status: 409 })
    }
    logError('ac-devices', 'insert failed', { locationId, err: insErr.message })
    return NextResponse.json({ success: false, error: 'Could not add the device.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, device }, { status: 201 })
}
