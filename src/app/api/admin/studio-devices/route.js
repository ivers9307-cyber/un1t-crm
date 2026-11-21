// STUDIO-PIN.2 — GET + POST /api/admin/studio-devices
//
// Master-only. GET lists every paired device across every location;
// POST pairs a new device — server generates a 256-bit token, stores
// only the sha256 hash, returns the cleartext token in the response
// ONCE so the master can paste it into the device's pairing screen.
//
// Revoke + per-device detail live in [id]/route.js.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { validateBody, uuidLike } from '@/lib/validate'
import { generateDeviceToken } from '@/lib/studio-devices'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in: signed out is its 401 (a 403 before). A
// non-master keeps the same 403 'Forbidden', checked here on profiles.role as
// requireMaster did (this master-only surface lists every studio's devices).
const notMaster = (user) => user.profileRole !== 'master'
const forbidden = () => NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

export const GET = withAuth({ permission: null, location: false }, async ({ user, db }) => {
  if (notMaster(user)) return forbidden()

  // Join in location label for readability. Pull the lockout window
  // count too so the admin UI can show "3 failed attempts in the
  // last 15 min" without a second query.
  const { data, error } = await db
    .from('studio_devices')
    .select('id, location_id, device_kind, label, paired_at, paired_by, last_seen_at, revoked_at')
    .order('paired_at', { ascending: false })
  if (error) {
    logError('studio-devices', 'device list failed', { err: error })
    return NextResponse.json({ success: false, error: 'Could not load the devices. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, devices: data || [] })
})

const PairBody = z.object({
  location_id: uuidLike,
  device_kind: z.enum(['mac', 'ipad']),
  label: z.string().min(1).max(80),
})

export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  if (notMaster(user)) return forbidden()

  const validation = await validateBody(request, PairBody)
  if (!validation.ok) return validation.response
  const { location_id, device_kind, label } = validation.data

  // Ensure the location exists — surface a clean 404 instead of a
  // generic FK violation.
  const { data: loc } = await db
    .from('locations').select('id, name').eq('id', location_id).single()
  if (!loc) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }

  const { token, hash } = generateDeviceToken()

  const { data: row, error: insErr } = await db
    .from('studio_devices')
    .insert({
      location_id,
      device_token_hash: hash,
      device_kind,
      label,
      paired_by: user.id,
    })
    .select('id, location_id, device_kind, label, paired_at')
    .single()
  if (insErr) {
    logError('studio-devices', 'device pair insert failed', { locationId: location_id, err: insErr })
    return NextResponse.json({ success: false, error: 'Could not pair the device. Try again.' }, { status: 500 })
  }

  // Audit — token value NEVER hits the log.
  await logAuditEvent({
    category: 'business',
    action: 'studio_device.paired',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { resource: `studio_devices/${row.id}`, label },
    locationId: location_id,
    details: { device_kind, label, location_name: loc.name },
    request,
  })

  // Cleartext token returned ONCE. After this response the master
  // must paste it into the device's pairing screen; it can't be
  // retrieved later.
  return NextResponse.json({
    success: true,
    device: row,
    pairing_token: token,
  })
})
