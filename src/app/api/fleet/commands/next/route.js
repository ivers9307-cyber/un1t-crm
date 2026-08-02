// FLEET-CMD.1 — the agent asks what it should do.
//
// GET /api/fleet/commands/next   Bearer fdv_…  ->  { ok, command: {…}|null }
//
// Called by the Pi agent after the Realtime doorbell rings (and once on
// startup, in case a command landed while it was restarting). The doorbell
// carries no payload, so this is where the agent actually learns the action —
// and it is authenticated, which is what lets the broadcast channel be public.
//
// Claiming is a transition, not a read: the returned command is marked
// `claimed` so a second call does not hand the same action out twice.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyFleetDeviceToken } from '@/lib/fleet-device-auth'
import { actionAppliesToRole } from '@/lib/fleet-commands'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const db = createServerClient()
  const device = await verifyFleetDeviceToken(request, db)
  if (!device) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }

  const now = new Date().toISOString()

  // Oldest first, and only for THIS device — the token cannot address another.
  // Expired rows are filtered here as well as swept by the cron, because the
  // sweep runs every 5 minutes and the TTL is 2: without this filter an agent
  // reconnecting after a blip could pick up a command that should be dead.
  const { data: pending, error } = await db
    .from('fleet_commands')
    .select('id, action, issued_at, expires_at')
    .eq('device_name', device.device_name)
    .eq('status', 'pending')
    .gt('expires_at', now)
    .order('issued_at', { ascending: true })
    .limit(1)

  if (error) {
    logWarn('fleet-cmd', 'failed to read pending commands', {
      device: device.device_name, err: error,
    })
    return NextResponse.json({ ok: false, error: 'Lookup failed' }, { status: 500 })
  }

  const command = pending?.[0]
  if (!command) return NextResponse.json({ ok: true, command: null })

  // Refuse anything that does not match this device's role, and record the
  // refusal rather than staying silent. The issue route checks this too; this
  // is the second half of the same guard, on the side that would actually run
  // the command. If they ever disagree, the device wins.
  if (!actionAppliesToRole(command.action, device.role)) {
    await db.from('fleet_commands').update({
      status: 'rejected',
      finished_at: now,
      error: `action does not apply to a ${device.role ?? 'roleless'} device`,
    }).eq('id', command.id)
    logWarn('fleet-cmd', 'rejected mismatched action', {
      device: device.device_name, role: device.role, action: command.action,
    })
    return NextResponse.json({ ok: true, command: null })
  }

  // Claim it. Conditional on still being `pending` so two agents racing (a
  // restart overlapping its predecessor) cannot both take the same row —
  // whoever loses updates zero rows and gets nothing to do.
  const { data: claimed } = await db
    .from('fleet_commands')
    .update({ status: 'claimed', claimed_at: now })
    .eq('id', command.id)
    .eq('status', 'pending')
    .select('id, action, expires_at')
    .maybeSingle()

  if (!claimed) return NextResponse.json({ ok: true, command: null })

  logInfo('fleet-cmd', 'command claimed', {
    device: device.device_name, action: claimed.action, id: claimed.id,
  })

  return NextResponse.json({ ok: true, command: claimed })
}
