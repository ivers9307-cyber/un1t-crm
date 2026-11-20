// STUDIO-PIN — GET /api/admin/studio-devices/activity
//
// Master-only. Returns the most recent pin_login_attempts so the admin
// page can show WHY a device failed to sign in — the true gate
// (untrusted_ip / unknown_device / wrong_pin / device_locked / success)
// that the device-facing response deliberately hides behind a generic
// "Not allowed". Reading the truth here, behind the master gate, does
// not weaken that anti-enumeration posture.
//
// Two bulk lookups resolve device label/location + matched-staffer name
// rather than a PostgREST embed: pin_login_attempts has no FK to
// profiles (matched_profile is a bare uuid), and device_id can be null
// (unknown-device attempts) or point at a soft-deleted (revoked) device
// whose label we still want to show.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LIMIT = 50

// withAuth only signs the caller in (signed out is its 401). Masters only
// (profiles.role, never a studio role), refused with the same 403 'Forbidden'.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db }) => {
  if (user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const { data: attempts, error } = await db
    .from('pin_login_attempts')
    .select('id, attempted_at, outcome, source_ip, device_id, matched_profile')
    .order('attempted_at', { ascending: false })
    .limit(LIMIT)
  if (error) {
    logError('studio-devices-activity', 'attempts read failed', { err: error })
    return NextResponse.json({ success: false, error: 'Could not read the sign-in activity.' }, { status: 500 })
  }
  const rows = attempts || []

  const deviceIds = [...new Set(rows.map((r) => r.device_id).filter(Boolean))]
  const profileIds = [...new Set(rows.map((r) => r.matched_profile).filter(Boolean))]

  const deviceById = {}
  if (deviceIds.length) {
    const { data: devices } = await db
      .from('studio_devices')
      .select('id, label, device_kind, location_id')
      .in('id', deviceIds)
    for (const d of devices || []) deviceById[d.id] = d
  }

  const nameById = {}
  if (profileIds.length) {
    const { data: profiles } = await db
      .from('profiles')
      .select('id, full_name')
      .in('id', profileIds)
    for (const p of profiles || []) nameById[p.id] = p.full_name
  }

  const activity = rows.map((r) => {
    const device = deviceById[r.device_id] || null
    return {
      id: r.id,
      attempted_at: r.attempted_at,
      outcome: r.outcome,
      source_ip: r.source_ip,
      matched_name: r.matched_profile ? nameById[r.matched_profile] || null : null,
      device: device
        ? {
            id: device.id,
            label: device.label,
            device_kind: device.device_kind,
            location_id: device.location_id,
          }
        : null,
    }
  })

  return NextResponse.json({ success: true, attempts: activity })
})
