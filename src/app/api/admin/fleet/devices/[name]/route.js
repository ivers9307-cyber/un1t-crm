// FLEET-CMD.1 — claim a discovered device.
//
// PATCH /api/admin/fleet/devices/[name]  { location_id, role, label }
//
// The fleet-health cron auto-registers whatever Tailscale reports, so a newly
// provisioned Pi arrives here with no location and no role — visible, but
// inert: outside everyone's scope and offering no actions. This is where a
// master gives it a home.
//
// Master-only. Deciding which studio a device belongs to is a registry
// decision, not a floor-staff one, and location_id is what every downstream
// permission check scopes against.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ClaimSchema = z.object({
  location_id: uuidLike,
  // The role is what makes actions applicable, so it is required at claim
  // time rather than optional — a claimed device with no role would look
  // configured while still offering nothing.
  role: z.enum(['kiosk', 'bridge']),
  label: z.string().max(80).trim().optional().transform((v) => (v ? v : null)),
})

export async function PATCH(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!user.isMaster) {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  const validation = await validateBody(request, ClaimSchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const { data, error } = await db
    .from('fleet_devices')
    .update({ ...validation.data, updated_at: new Date().toISOString() })
    .eq('device_name', params.name)
    .select('device_name, location_id, role, label')
    .maybeSingle()

  if (error) {
    logWarn('fleet-cmd', 'failed to claim device', { device: params.name, err: error })
    return NextResponse.json({ ok: false, error: 'Could not update device' }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  }

  logInfo('fleet-cmd', 'device claimed', { device: params.name, by: user.id })
  return NextResponse.json({ ok: true, device: data })
}
