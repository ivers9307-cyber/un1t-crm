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
import FleetAdmin from './FleetAdmin'

export const dynamic = 'force-dynamic'

export default async function FleetPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()

  const { data: devices } = await db
    .from('fleet_devices')
    .select('device_name, location_id, role, label, api_token_hash, last_render_at, locations(name)')
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

  if (!visible.length) {
    return (
      <div className="p-6">
        <p className="text-sm text-un1t-subtle">
          You do not have access to any studio devices.
        </p>
      </div>
    )
  }

  const names = visible.map((d) => d.device_name)

  const [{ data: health }, { data: commands }, { data: locations }] = await Promise.all([
    db.from('fleet_device_health')
      .select('device_name, state, state_since, suppressed_until, last_checked')
      .in('device_name', names),
    db.from('fleet_commands')
      .select('id, device_name, action, status, issued_at, finished_at, error, profiles:issued_by(full_name)')
      .in('device_name', names)
      .order('issued_at', { ascending: false })
      .limit(25),
    user.isMaster
      ? db.from('locations').select('id, name').eq('is_host_anchor', false).order('name')
      : Promise.resolve({ data: [] }),
  ])

  const healthByName = new Map((health || []).map((h) => [h.device_name, h]))

  // Resolve each device's offered actions server-side so the client never has
  // to know the permission rules — and so the buttons cannot disagree with
  // what the API will accept.
  const rows = visible.map((d) => {
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

  return (
    <FleetAdmin
      devices={rows}
      commands={commands || []}
      locations={locations || []}
      isMaster={Boolean(user.isMaster)}
    />
  )
}
