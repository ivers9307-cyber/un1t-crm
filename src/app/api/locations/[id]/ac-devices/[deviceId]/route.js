// PATCH /api/locations/[id]/ac-devices/[deviceId] — master only: rename,
// regroup, change defaults, disable ({ enabled: false }, a soft disable so
// past sessions keep their device), or re-enable ({ enabled: true }).
//
// ACDEVLOC.1 — replaces PATCH + DELETE /api/studio-management/ac/devices/[id].
// PATCH went through loadDeviceForUser, which refuses a DISABLED unit (409),
// so Re-enable never worked; DELETE checked nothing but the role. Here the unit
// must belong to the location in the PATH (else 404, like a missing one), and
// the write is scoped to it too.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { logError } from '@/lib/log'
import { normaliseDevicePatch } from '@/lib/ac-device-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// z.object strips unknown keys, so provider / provider_device_id /
// location_id never reach normaliseDevicePatch.
const PatchBody = z.object({
  label: z.string().max(120).optional(),
  device_group: z.string().max(120).nullable().optional(),
  default_mode: z.string().max(20).optional(),
  default_temp_c: z.union([z.number(), z.string()]).optional(),
  default_fan: z.string().max(20).optional(),
  session_minutes: z.union([z.number(), z.string()]).optional(),
  external_auto_off_minutes: z.union([z.number(), z.string()]).nullable().optional(),
  enabled: z.boolean().optional(),
})

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

// withAuth: signed in, a member of the path's studio (else its 404, as
// assertLocationAccessOr404 answered), then master only with the old 403 words.
export const PATCH = withAuth({ permission: null, location: 'param', master: true, forbiddenMessage: 'Only master can edit AC devices.' }, async ({ db, request, params }) => {
  const locationId = params.id
  const deviceId = params?.deviceId || null
  if (!uuidLike.safeParse(deviceId).success) return notFound()

  const parsed = await validateBody(request, PatchBody)
  if (!parsed.ok) return parsed.response
  const norm = normaliseDevicePatch(parsed.data)
  if (norm.error) return NextResponse.json({ success: false, error: norm.error }, { status: 400 })

  const { data: existing, error: readErr } = await db
    .from('ac_devices')
    .select('id, location_id')
    .eq('id', deviceId)
    .maybeSingle()
  if (readErr) {
    logError('ac-devices', 'device read failed', { locationId, deviceId, err: readErr.message })
    return NextResponse.json({ success: false, error: 'Could not load the device. Nothing was changed.' }, { status: 500 })
  }
  if (!existing || existing.location_id !== locationId) return notFound()

  const { data: device, error: updErr } = await db
    .from('ac_devices')
    .update(norm.patch)
    .eq('id', deviceId)
    .eq('location_id', locationId)
    .select('id, location_id, label, provider, device_group, default_mode, default_temp_c, default_fan, session_minutes, external_auto_off_minutes, enabled, created_at, updated_at')
    .single()
  if (updErr) {
    logError('ac-devices', 'device update failed', { locationId, deviceId, err: updErr.message })
    return NextResponse.json({ success: false, error: 'Could not save the device.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, device })
})
