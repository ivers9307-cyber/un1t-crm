// FLEET-CMD.1 — /admin/fleet, remote actions for the studio Raspberry Pis.
//
// Two permission tiers, split by blast radius rather than seniority (the same
// axis as equipment_admin vs equipment_inspect):
//
//   fleet_restart — restart a frozen kiosk browser, read logs. On for anyone
//                   on shift, because the person who notices a dead
//                   leaderboard is a coach standing in the room.
//   fleet_admin   — reboot, shut down, redeploy the bridge. Owner + master.
//
// The page renders for either key; the API re-checks the key for the SPECIFIC
// action, so holding fleet_restart never reaches a shutdown.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { expectedModesFor } from '@/lib/screen-plan'
import FleetAdmin from './FleetAdmin'

export const dynamic = 'force-dynamic'

export default async function FleetPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()

  const { data: devices } = await db
    .from('fleet_devices')
    .select('device_name, location_id, role, label, api_token_hash, last_render_at, tv_display_id, last_heartbeat_at, reported_mode, reported_version, override_mode, override_until, locations(name), tv_displays(label)')
    .order('device_name', { ascending: true })

  // Scope in app code — this is a service-role read, so RLS does nothing here.
  // A device with no location is master-only: there is no location to check a
  // permission against, so nobody else can be shown to have rights over it.
  const visible = (devices || []).filter((d) => {
    if (user.isMaster) return true
    if (!d.location_id) return false
    return hasPermissionForLocation(user, d.location_id, 'fleet_restart')
      || hasPermissionForLocation(user, d.location_id, 'fleet_admin')
  })

  // A master with nothing registered yet still needs the page: it holds the
  // form that registers the first screen.
  if (!visible.length && !user.isMaster) {
    return (
      <div className="p-6">
        <p className="text-sm text-un1t-subtle">
          You do not have access to any studio devices.
        </p>
      </div>
    )
  }

  const names = visible.map((d) => d.device_name)

  const [{ data: health }, { data: commands }] = await Promise.all([
    db.from('fleet_device_health')
      .select('device_name, state, state_since, suppressed_until, last_checked')
      .in('device_name', names),
    db.from('fleet_commands')
      .select('id, device_name, action, status, issued_at, finished_at, error, screenshot_path, profiles:issued_by(full_name)')
      .in('device_name', names)
      .order('issued_at', { ascending: false })
      .limit(25),
  ])

  const healthByName = new Map((health || []).map((h) => [h.device_name, h]))

  // The Android TV screens are a different kind of device from the Pis: they
  // are not on the tailnet, take no remote commands and carry their own state
  // (heartbeat, mode, override), so they are drawn by their own section.
  const screenDevices = visible.filter((d) => d.role === 'screen')
  const piDevices = visible.filter((d) => d.role !== 'screen')

  // Resolve each device's offered actions server-side so the client never has
  // to know the permission rules — and so the buttons cannot disagree with
  // what the API will accept.
  const rows = piDevices.map((d) => {
    const can = (key) => user.isMaster
      || (d.location_id ? hasPermissionForLocation(user, d.location_id, key) : false)
    return {
      device_name: d.device_name,
      role: d.role,
      label: d.label,
      location: d.locations?.name ?? null,
      claimed: Boolean(d.location_id),
      hasToken: Boolean(d.api_token_hash),
      // FLEET-CMD.2 — null means this kiosk has never reported a render, which
      // is "not yet redeployed", not "dark". The UI must say which.
      lastRenderAt: d.last_render_at,
      health: healthByName.get(d.device_name) ?? null,
      canRestart: can('fleet_restart'),
      canAdmin: can('fleet_admin'),
    }
  })

  // SCREENMODE.11 — what each screen should be showing right now, from the
  // same reads the box's plan endpoint uses. `null` for a device means "no
  // expectation": the studio's screen_mode automation is absent or disabled,
  // or its reads failed — the UI shows a dash, never a guess. A device that an
  // ENABLED studio's config does not list answers 'marketing'. One call for
  // all screens (it reads once per studio).
  const nowMs = Date.now()
  const expected = await expectedModesFor(
    db,
    screenDevices.filter((d) => d.location_id),
    { nowMs },
  )

  const screens = screenDevices.map((d) => {
    // Only an override that is still in force; an expired one is just a stale
    // column, and the box has already gone back to its schedule.
    const untilMs = d.override_until ? Date.parse(d.override_until) : NaN
    const live = d.override_mode && Number.isFinite(untilMs) && untilMs > nowMs
    return {
      device_name: d.device_name,
      label: d.label,
      location: d.locations?.name ?? null,
      locationId: d.location_id,
      displayLabel: d.tv_displays?.label ?? null,
      // Presence only — the hash itself never leaves the server.
      hasToken: Boolean(d.api_token_hash),
      lastHeartbeatAt: d.last_heartbeat_at,
      reportedMode: d.reported_mode,
      reportedVersion: d.reported_version,
      expectedMode: expected.get(d.device_name) ?? null,
      override: live ? { mode: d.override_mode, until: d.override_until } : null,
      canOverride: user.isMaster
        || (d.location_id ? hasPermissionForLocation(user, d.location_id, 'fleet_restart') : false),
    }
  })

  // Registering a screen is master-only, so only a master is sent the choices
  // for it. Everyone else gets empty lists.
  let locations = []
  let displays = []
  if (user.isMaster) {
    const [{ data: locationRows }, { data: displayRows }] = await Promise.all([
      db.from('locations').select('id, name').order('name'),
      db.from('tv_displays').select('id, label, location_id').eq('active', true).order('label'),
    ])
    locations = locationRows || []
    displays = displayRows || []
  }

  return (
    <FleetAdmin
      devices={rows}
      screens={screens}
      locations={locations}
      displays={displays}
      commands={commands || []}
      isMaster={Boolean(user.isMaster)}
    />
  )
}
