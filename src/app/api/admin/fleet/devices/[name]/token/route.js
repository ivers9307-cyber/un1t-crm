// FLEET-CMD.1 — issue or rotate a device's agent credential.
//
// POST /api/admin/fleet/devices/[name]/token  ->  { ok, token: 'fdv_…' }
//
// The raw token is returned ONCE and never stored — only its sha256 hash goes
// on the row, the same discipline as the bridge tokens. It has to be pasted
// into the Pi's /etc/un1t-pi/agent.env (or supplied at provisioning) before
// the agent can fetch anything.
//
// Rotation is the revocation mechanism: issuing a new token invalidates the
// old one immediately, because only one hash is kept. There is deliberately no
// grace window like ble_bridges.previous_token_hash — a Pi that misses a
// rotation stops fetching commands, which is a visible, harmless failure,
// whereas a stolen agent token staying live for a grace period is not.
//
// Master-only, like the rest of the registry.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { issueDeviceToken } from '@/lib/fleet-device-auth'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!user.isMaster) {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  const db = createServerClient()
  const { raw, hash } = issueDeviceToken()

  const { data, error } = await db
    .from('fleet_devices')
    .update({
      api_token_hash: hash,
      token_issued_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('device_name', params.name)
    .select('device_name')
    .maybeSingle()

  if (error) {
    logWarn('fleet-cmd', 'failed to rotate device token', { device: params.name, err: error })
    return NextResponse.json({ ok: false, error: 'Could not issue token' }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  }

  // Logged as an event, never with the value.
  logInfo('fleet-cmd', 'device token rotated', { device: params.name, by: user.id })

  return NextResponse.json({ ok: true, token: raw })
}
