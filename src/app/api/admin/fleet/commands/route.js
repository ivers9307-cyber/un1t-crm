// FLEET-CMD.1 — issue a remote action to a studio Pi.
//
// POST /api/admin/fleet/commands  { device_name, action } -> { ok, command }
// GET  /api/admin/fleet/commands                          -> recent history
//
// This route runs as service role and therefore bypasses RLS entirely, so the
// checks below ARE the security model — the policies on fleet_commands only
// stop an accidental browser client.
//
// Three gates, in order, and all three matter:
//
//   1. the action must be on the allowlist        (never a command string)
//   2. it must apply to THIS DEVICE'S ROLE        (no redeploy_bridge on a TV)
//   3. the caller must hold the key for THAT      (not the key that rendered
//      SPECIFIC action, AT THAT LOCATION          the page)
//
// Gate 3 is the one worth guarding in review. A coach holds `fleet_restart`,
// so the page renders for them; if this route checked the page's permission
// instead of the action's, a hand-rolled POST would let them shut a Pi down.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { logInfo, logWarn } from '@/lib/log'
import {
  ACTION_NAMES,
  isKnownAction,
  actionAppliesToRole,
  permissionForAction,
  expiryFor,
  suppressionFor,
} from '@/lib/fleet-commands'
import { pingDevice } from '@/lib/fleet-doorbell'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const IssueSchema = z.object({
  device_name: z.string().min(1).max(100),
  // The enum IS the allowlist. An unknown action never reaches the database,
  // where the CHECK constraint is the backstop rather than the gate.
  action: z.enum(ACTION_NAMES),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }

  const validation = await validateBody(request, IssueSchema)
  if (!validation.ok) return validation.response
  const { device_name, action } = validation.data

  // Belt and braces with the Zod enum: if someone widens the schema later,
  // this still refuses anything not in ACTIONS.
  if (!isKnownAction(action)) {
    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: device } = await db
    .from('fleet_devices')
    .select('device_name, location_id, role, label')
    .eq('device_name', device_name)
    .maybeSingle()

  // 404 rather than 403 so device names cannot be enumerated by a caller who
  // is allowed to reach this route at all.
  if (!device) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  }

  // An unclaimed device (auto-registered by the fleet-health cron, never given
  // a location) is master-only: there is no location to scope a permission
  // against, so nobody else can be shown to have rights over it.
  if (!device.location_id) {
    if (!user.isMaster) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
    }
  } else {
    const key = permissionForAction(action)
    if (!user.isMaster && !hasPermissionForLocation(user, device.location_id, key)) {
      return NextResponse.json({ ok: false, error: 'Not permitted' }, { status: 403 })
    }
  }

  // Role applicability. A kiosk has no champ-bridge to redeploy and a bridge
  // has no browser to restart; offering either would produce a command the
  // agent would only reject.
  if (!actionAppliesToRole(action, device.role)) {
    return NextResponse.json({
      ok: false,
      error: device.role
        ? `${action} does not apply to a ${device.role} device`
        : 'This device has not been assigned a role yet',
    }, { status: 400 })
  }

  const now = Date.now()
  const { data: command, error } = await db
    .from('fleet_commands')
    .insert({
      device_name,
      action,
      issued_by: user.id,
      expires_at: expiryFor(now),
    })
    .select('id, device_name, action, status, issued_at, expires_at')
    .single()

  if (error || !command) {
    logWarn('fleet-cmd', 'failed to issue command', { device_name, action, err: error })
    return NextResponse.json({ ok: false, error: 'Could not issue command' }, { status: 500 })
  }

  // Open the maintenance window at ISSUE time, not on claim.
  //
  // Issuing early is safe because decideAlert clears the window the moment the
  // device is genuinely back in contact — so if the command never lands, the
  // next tick that sees the Pi online wipes it. Waiting for the claim would
  // leave a gap between the agent halting the device and the CRM knowing.
  //
  // Only shutdown suppresses; see fleet-commands.js for why reboot does not.
  const suppress = suppressionFor(action, now)
  if (suppress) {
    const { error: supErr } = await db
      .from('fleet_device_health')
      .update({ suppressed_until: suppress })
      .eq('device_name', device_name)
    // Not fatal. The worst case is an alert about a device the operator
    // deliberately switched off — noisy, but far better than failing the
    // shutdown they asked for.
    if (supErr) logWarn('fleet-cmd', 'failed to suppress alerts', { device_name, err: supErr })
  }

  // Ring the doorbell. Best-effort by design: if the broadcast fails the agent
  // simply does not hear about it and the command expires in two minutes,
  // which is the correct outcome and is visible in the UI.
  await pingDevice(device_name)

  logInfo('fleet-cmd', 'command issued', {
    device_name, action, by: user.id, id: command.id,
  })

  return NextResponse.json({ ok: true, command })
}

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const { data: devices } = await db
    .from('fleet_devices')
    .select('device_name, location_id')

  // Scope the history to devices the caller can act on at all. Masters see
  // everything, including unclaimed devices.
  const visible = (devices || []).filter((d) => {
    if (user.isMaster) return true
    if (!d.location_id) return false
    return hasPermissionForLocation(user, d.location_id, 'fleet_restart')
      || hasPermissionForLocation(user, d.location_id, 'fleet_admin')
  }).map((d) => d.device_name)

  if (!visible.length) return NextResponse.json({ ok: true, commands: [] })

  const { data: commands } = await db
    .from('fleet_commands')
    .select('id, device_name, action, status, issued_at, finished_at, exit_code, error, screenshot_path, profiles:issued_by(full_name)')
    .in('device_name', visible)
    .order('issued_at', { ascending: false })
    // Matches the page's server-rendered slice, so a poll cannot make the list
    // jump in length the first time it refreshes.
    .limit(25)

  return NextResponse.json({ ok: true, commands: commands || [] })
}
