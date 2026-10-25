// SCREENMODE.7 — register a floor screen.
//
// POST /api/admin/fleet/devices
//   { device_name, location_id, role: 'screen', label?, tv_display_id? }
//   -> 201 { ok, device }
//
// A Pi is registered by the fleet-health cron when Tailscale reports it, then
// claimed through PATCH /devices/[name]. An Android TV box never appears on
// the tailnet, so a master creates its row here, ahead of the box's first
// plan request. Only the screen role may be created by hand: a hand-made Pi
// row would never be health-graded.
//
// Master-only, for the same reason as the claim route: which studio a device
// belongs to is a registry decision, and location_id is what every downstream
// permission check scopes against.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { assertDisplayAtLocation } from '@/lib/screen-plan'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CreateSchema = z.object({
  device_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  location_id: uuidLike,
  role: z.enum(['screen']),
  label: z.string().max(80).trim().optional(),
  tv_display_id: uuidLike.nullable().optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!user.isMaster) {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  const validation = await validateBody(request, CreateSchema)
  if (!validation.ok) return validation.response
  const { device_name, location_id, role, label, tv_display_id } = validation.data

  const db = createServerClient()

  if (tv_display_id) {
    const check = await assertDisplayAtLocation(db, tv_display_id, location_id)
    if (!check.ok) {
      return NextResponse.json({ ok: false, error: 'display_not_at_location' }, { status: 400 })
    }
  }

  const { data, error } = await db
    .from('fleet_devices')
    .insert({ device_name, location_id, role, label: label || null, tv_display_id: tv_display_id ?? null })
    .select('device_name, location_id, role, label, tv_display_id')
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ ok: false, error: 'exists' }, { status: 409 })
    }
    logWarn('fleet-cmd', 'failed to register screen', { device: device_name, err: error })
    return NextResponse.json({ ok: false, error: 'Could not create device' }, { status: 500 })
  }

  logInfo('fleet-cmd', 'screen registered', { device: device_name, by: user.id })
  return NextResponse.json({ ok: true, device: data }, { status: 201 })
}
