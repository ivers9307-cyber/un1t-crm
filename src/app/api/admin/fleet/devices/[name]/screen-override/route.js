// SCREENMODE.8 — put a floor screen into a mode for a while, or clear that.
//
// POST /api/admin/fleet/devices/[name]/screen-override
//   { mode: 'class_app' | 'marketing', minutes: 30 | 60 | 120 | 240 }  -> set
//   { clear: true }                                                    -> clear
//   -> 200 { ok, override: { mode, until } | null }
//
// The override is device state (override_mode / override_until on the
// fleet_devices row), not a command: the box reads it in its next plan, and
// the doorbell wakes it so it does not wait out the poll interval. A failed
// ring costs a delay, never the saved override.
//
// Gates, in order: a session; the device must exist, be a screen and have a
// studio, and the caller must be master or hold `fleet_restart` AT THAT
// DEVICE'S studio (the key that lets a coach restart a frozen kiosk). Failing
// any of those is the same 404, so the route never tells a caller which names
// are screens, or which studio a screen belongs to.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { SCREEN_MODES, OVERRIDE_MINUTES } from '@/lib/screen-mode'
import { ringScreens } from '@/lib/screen-doorbell'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const OverrideSchema = z.union([
  z.object({
    mode: z.enum(SCREEN_MODES),
    minutes: z.union(OVERRIDE_MINUTES.map((m) => z.literal(m))),
  }),
  z.object({ clear: z.literal(true) }),
])

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }

  const validation = await validateBody(request, OverrideSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: device, error: readError } = await db
    .from('fleet_devices')
    .select('device_name, role, location_id')
    .eq('device_name', params.name)
    .maybeSingle()
  if (readError) {
    logWarn('fleet-cmd', 'screen override: device unreadable', { device: params.name, err: readError })
    return NextResponse.json({ ok: false, error: 'Could not set override' }, { status: 500 })
  }
  const notFound = () => NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  if (!device || device.role !== 'screen' || !device.location_id) return notFound()
  if (!(user.isMaster || hasPermissionForLocation(user, device.location_id, 'fleet_restart'))) {
    return notFound()
  }

  const override = 'clear' in body
    ? null
    : { mode: body.mode, until: new Date(Date.now() + body.minutes * 60_000).toISOString() }

  const { data: updated, error } = await db
    .from('fleet_devices')
    .update({
      override_mode: override ? override.mode : null,
      override_until: override ? override.until : null,
      updated_at: new Date().toISOString(),
    })
    .eq('device_name', device.device_name)
    .eq('location_id', device.location_id)
    .select('device_name')
    .maybeSingle()
  if (error) {
    logWarn('fleet-cmd', 'failed to set screen override', { device: device.device_name, err: error })
    return NextResponse.json({ ok: false, error: 'Could not set override' }, { status: 500 })
  }
  // Deleted or moved between the read and the write: nothing was changed, so
  // there is nothing to log or ring.
  if (!updated) return notFound()

  logInfo('fleet-cmd', 'screen override', {
    device: device.device_name, mode: override ? override.mode : 'clear', by: user.id,
  })

  // Best effort: the override is saved, the box will pick it up on its next poll.
  try {
    await ringScreens([device.device_name])
  } catch (err) {
    logWarn('fleet-cmd', 'screen override saved; doorbell failed', { device: device.device_name, err: String(err) })
  }

  return NextResponse.json({ ok: true, override })
}
