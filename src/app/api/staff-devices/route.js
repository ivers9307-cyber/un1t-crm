// GET /api/staff-devices — the STAFF-DEV fleet payload: every active
// staff profile with their registered devices, the derived target app
// version and a per-person verdict (current / outdated / unknown
// version / no device).
//
// One endpoint feeds all three surfaces (device-health page, staff-list
// Device column, per-staff Devices card) so they can never disagree
// about who is behind. Every verdict comes from `@/lib/staff-devices`
// (pure; the clock is injected here, once, so the whole payload is
// computed against a single "now").
//
// SECURITY: this is a service-role read — RLS does nothing here. The
// getCurrentUser + hasPermission(user,'settings') gate below is the ONLY
// thing keeping the fleet (names, emails, devices) away from ordinary
// staff. Same gate as /settings/notifications/health, which this backs.
//
// Both selects are bounded by the size of the staff table (~22 profiles,
// ~11 devices today), so there is no pagination — well clear of the
// 1,000-row PostgREST cap.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { deriveTargetVersion, deviceVerdict, currentDevice, isStale } from '@/lib/staff-devices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'settings')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()

  // supabase-js builders are thenables, not Promises — try/await/catch,
  // never `.catch()`.
  let profiles = []
  let devices = []
  try {
    const [profilesRes, devicesRes] = await Promise.all([
      db.from('profiles').select('id, full_name, email, role, active').eq('active', true),
      db
        .from('device_tokens')
        .select(
          'id, user_id, platform, device_name, app_version, last_seen_at, created_at, geofence_permission, geofence_permission_at',
        )
        .order('last_seen_at', { ascending: false }),
    ])
    if (profilesRes.error) throw new Error(profilesRes.error.message)
    if (devicesRes.error) throw new Error(devicesRes.error.message)
    profiles = profilesRes.data || []
    devices = devicesRes.data || []
  } catch (err) {
    console.error('[staff-devices] load failed', err)
    return NextResponse.json({ success: false, error: 'Failed to load staff devices' }, { status: 500 })
  }

  // One clock for the whole payload — the lib itself stays pure.
  const now = Date.now()

  const byUser = new Map()
  for (const device of devices) {
    if (!device?.user_id) continue
    const list = byUser.get(device.user_id)
    if (list) list.push(device)
    else byUser.set(device.user_id, [device])
  }
  // The query already orders by last_seen_at, but sort in JS too so the
  // array order is deterministic regardless of how the rows arrive.
  // Missing/unparseable last_seen_at sorts as epoch 0 (i.e. last) — a
  // sentinel rather than -Infinity so two of them subtract to 0, not NaN.
  const seenMs = (d) => {
    const ms = d?.last_seen_at ? Date.parse(d.last_seen_at) : NaN
    return Number.isNaN(ms) ? 0 : ms
  }
  for (const list of byUser.values()) list.sort((a, b) => seenMs(b) - seenMs(a))

  const targetVersion = deriveTargetVersion(devices, now)

  const staff = profiles.map((profile) => {
    const own = byUser.get(profile.id) || []
    const verdict = deviceVerdict(own, targetVersion, now)
    // Staff-level permission reflects the CURRENT device only — an old
    // iPad that once granted "always" says nothing about the phone the
    // person actually carries.
    const current = currentDevice(own)
    return {
      id: profile.id,
      full_name: profile.full_name,
      email: profile.email,
      role: profile.role,
      verdict,
      geofence_permission: current?.geofence_permission ?? null,
      geofence_permission_at: current?.geofence_permission_at ?? null,
      devices: own.map((d) => ({
        id: d.id,
        platform: d.platform,
        device_name: d.device_name,
        app_version: d.app_version,
        last_seen_at: d.last_seen_at,
        created_at: d.created_at,
        stale: isStale(d, now),
        geofence_permission: d.geofence_permission ?? null,
        geofence_permission_at: d.geofence_permission_at ?? null,
      })),
    }
  })

  return NextResponse.json({ success: true, data: { target_version: targetVersion, staff } })
}
