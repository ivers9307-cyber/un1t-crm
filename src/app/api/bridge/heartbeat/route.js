// POST /api/bridge/heartbeat
//
// Bridge keepalive. Updates ble_bridges.last_seen_at + status +
// software_version, and (BRIDGE-BLIND.1) persists the self-reported
// telemetry that rides along with it.
//
// Request body: { software_version?: string, status?: 'online' | 'error',
//                 pending_samples?: number, uptime_s?: number,
//                 adapters?: { ant?: {...}, ble?: {...} } }
//               — the telemetry keys arrive FLAT (champ-bridge's
//                 postHeartbeat spreads them); a nested `telemetry`
//                 object is also accepted. See src/lib/bridge-telemetry.js.
// Response:     { ok: true, server_time: ISO } — server_time helps
//               the bridge spot clock skew (it warns if drift > 5min).
//               UNCHANGED by BRIDGE-BLIND.1: the bridge parses this,
//               and telemetry is a thing we now keep, not a thing we
//               answer about.
//
// Auth: bearer token via verifyBridgeToken. Anything else → 401.
//
// WHY THE TELEMETRY LANDS HERE and not in the sample path: this endpoint is
// already a ~30s cadence write of a single row, so persisting five more
// columns on it is free. /api/bridge/samples is the hot path and stays
// untouched. The 5-minute fleet-health cron does all the reasoning.
//
// 2026-08-12: the Stillorgan bridge heartbeated healthily for 2.5h with a
// wedged ANT+ scanner and a BLE radio that noble had refused to power on,
// while ingesting zero samples across two full classes. It was SAYING so on
// every heartbeat — `adapters.ble.powered_on: false` — and this route threw
// the payload away.

import { NextResponse } from 'next/server'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { createServerClient } from '@/lib/supabase'
import { parseBridgeTelemetry } from '@/lib/bridge-telemetry'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const bridge = await verifyBridgeToken(request)
  if (!bridge) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  let body = {}
  try {
    body = await request.json()
  } catch {
    // Empty/invalid body is fine — heartbeats can be content-less.
  }

  const now = new Date().toISOString()
  const updates = {
    last_seen_at: now,
    status: 'online',
  }
  if (typeof body.software_version === 'string' && body.software_version.length < 64) {
    updates.software_version = body.software_version
  }
  if (body.status === 'error') updates.status = 'error'

  // BRIDGE-BLIND.1 — telemetry, defensively.
  //
  // parseBridgeTelemetry() cannot throw and returns null for a bridge on older
  // software, an empty keepalive, or a payload it could not make sense of. In
  // ALL of those cases we leave every telemetry column exactly as it was,
  // rather than writing nulls over it: one odd heartbeat is not evidence that a
  // previously-reported radio has stopped existing, and blanking last_ble_ok
  // would silently clear a live adapter_down alert and re-raise it moments
  // later. Absence is not a fault; only an explicit `false` is. The patch
  // carries only the keys this payload spoke to — see that module for why.
  //
  // last_telemetry_at reuses `now` so it cannot drift from last_seen_at within
  // one heartbeat — the gap between the two is precisely how you spot a bridge
  // that is alive but on software too old to say anything about itself.
  const telemetry = parseBridgeTelemetry(body)
  if (telemetry) Object.assign(updates, telemetry, { last_telemetry_at: now })

  const db = createServerClient()
  const { error } = await db
    .from('ble_bridges')
    .update(updates)
    .eq('id', bridge.bridgeId)
  if (error) {
    logWarn('bridge-heartbeat', 'failed to update last_seen_at', { err: error, bridgeId: bridge.bridgeId })
    // Don't fail the bridge over a soft DB issue; it'll retry on next tick.
    return NextResponse.json({ ok: false, error: 'persist_failed' }, { status: 200 })
  }

  return NextResponse.json({
    ok: true,
    server_time: new Date().toISOString(),
  })
}
