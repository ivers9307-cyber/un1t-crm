// POST /api/bridge/scan
//
// Bridge → server: snapshot of straps the bridge is currently
// seeing over ANT+ or BLE. Used by the coach pairing UI to render
// "available straps" for assignment.
//
// Body:
//   {
//     straps: [
//       { device_key: "ant:12345", name: null, rssi: null, last_bpm: 122 },
//       { device_key: "ble:AA:BB:CC:DD:EE:FF", name: "Polar H10",
//         rssi: -54, last_bpm: 118 },
//       ...
//     ]
//   }
//
// device_key is protocol-aware — `ant:<deviceNumber>` or `ble:<MAC>`.
// Stored as ble_bridges.last_seen_straps jsonb (whole-column
// overwrite — not historised). The coach UI reads it via the
// existing "Staff can view bridges at location" RLS policy.
//
// Bridge calls this every ~5s while a coach is in the pairing
// state, less often otherwise.

import { NextResponse } from 'next/server'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { createServerClient } from '@/lib/supabase'
import { canonicaliseDeviceKey } from '@/lib/bridge-samples'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_STRAPS = 100

export async function POST(request) {
  const bridge = await verifyBridgeToken(request)
  if (!bridge) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }

  const raw = Array.isArray(body?.straps) ? body.straps : null
  if (!raw) {
    return NextResponse.json({ ok: false, error: 'missing_straps' }, { status: 400 })
  }
  if (raw.length > MAX_STRAPS) {
    return NextResponse.json({ ok: false, error: 'too_many_straps', max: MAX_STRAPS }, { status: 413 })
  }

  const seenAt = new Date().toISOString()
  const cleaned = []
  for (const s of raw) {
    const deviceKey = canonicaliseDeviceKey(s?.device_key)
    if (!deviceKey) continue
    cleaned.push({
      device_key: deviceKey,
      name: typeof s?.name === 'string' ? s.name.slice(0, 60) : null,
      rssi: Number.isFinite(s?.rssi) ? Math.max(-127, Math.min(0, Math.round(s.rssi))) : null,
      last_bpm: Number.isFinite(s?.last_bpm) && s.last_bpm >= 30 && s.last_bpm <= 240
        ? Math.round(s.last_bpm) : null,
      seen_at: seenAt,
    })
  }

  const db = createServerClient()
  const { error } = await db
    .from('ble_bridges')
    .update({
      last_seen_straps: cleaned,
      last_seen_at: seenAt,
      status: 'online',
    })
    .eq('id', bridge.bridgeId)

  if (error) {
    logWarn('bridge-scan', 'failed to persist scan', { err: error, bridgeId: bridge.bridgeId })
    return NextResponse.json({ ok: false, error: 'persist_failed' }, { status: 200 })
  }

  // HR-DETECT.1 — best-effort: enrich the detection registry with strap name/RSSI
  // from this snapshot. Never blocks the scan ack.
  try {
    const { recordScanMetadata } = await import('@/lib/hr-detections')
    await recordScanMetadata(db, { locationId: bridge.locationId, bridgeId: bridge.bridgeId, straps: cleaned })
  } catch (e) {
    logWarn('bridge-scan', 'detection enrich threw', { err: e?.message || e })
  }

  return NextResponse.json({ ok: true, accepted: cleaned.length })
}
