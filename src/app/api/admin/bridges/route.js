// POST /api/admin/bridges  — register a new BLE bridge for a location.
// GET  /api/admin/bridges  — list bridges visible to the caller.
//
// Master-only for create + rotate. Listing is open to staff at the
// bridge's location (via existing RLS), but this admin route is the
// canonical management surface.
//
// Create response shape:
//   { ok: true, bridge: { id, name, hardware_id, location_id, ... },
//     token: 'bbr_…' }
//
// The raw token is shown ONCE in the response — the operator must
// paste it into the Pi's config immediately. We don't store the raw
// value anywhere (only the sha256 hash on the row), so a lost token
// requires a rotation.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { issueBridgeToken } from '@/lib/bridge-auth'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!user.isMaster) {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }

  const name = String(body?.name || '').trim().slice(0, 80)
  const locationId = String(body?.location_id || '').trim()
  const hardwareId = String(body?.hardware_id || '').trim().slice(0, 100)
  if (!name || !locationId || !hardwareId) {
    return NextResponse.json({
      ok: false,
      error: 'name, location_id and hardware_id are required',
    }, { status: 400 })
  }

  const { raw, hash } = issueBridgeToken()

  const db = createServerClient()
  const { data, error } = await db
    .from('ble_bridges')
    .insert({
      name,
      location_id: locationId,
      hardware_id: hardwareId,
      api_token_hash: hash,
      status: 'offline',
    })
    .select('id, name, hardware_id, location_id, status, created_at')
    .single()

  if (error) {
    if (/duplicate key/i.test(error.message || '')) {
      return NextResponse.json({
        ok: false,
        error: 'A bridge with this hardware_id already exists.',
      }, { status: 409 })
    }
    logWarn('bridge-admin', 'failed to insert ble_bridges', { err: error })
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 })
  }

  logInfo('bridge-admin', 'bridge created', {
    bridgeId: data.id,
    locationId,
    actor: user.id,
  })

  return NextResponse.json({
    ok: true,
    bridge: data,
    token: raw,
    setup_hint: 'Paste this token into the Pi\'s CHAMP_BRIDGE_TOKEN env. It will not be shown again.',
  }, { status: 201 })
}

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  // Read goes through RLS — non-master users see only their location's
  // bridges. Master sees everything.
  const db = createServerClient()
  const { data, error } = await db
    .from('ble_bridges')
    .select('id, name, hardware_id, location_id, status, software_version, last_seen_at, last_seen_straps, created_at')
    .order('created_at', { ascending: false })
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 })
  }
  return NextResponse.json({ ok: true, bridges: data || [] })
}
