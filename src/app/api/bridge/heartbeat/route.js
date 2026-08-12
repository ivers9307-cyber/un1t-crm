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
//
// BRIDGE-UNDELIVERED.1 adds ONE more written column, `pending_stuck_since`
// (mig 538): the marker that turns the historyless `pending_samples` reading
// into "how long has the bridge been holding samples it cannot send". See the
// block around it. The response contract is unchanged again.

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

  // BRIDGE-UNDELIVERED.1 — maintain `pending_stuck_since` (mig 538).
  //
  // `last_pending_samples` is a whole-column overwrite with no history, so
  // "the queue climbs and never falls" cannot be derived from it — one reading
  // of 3,200 looks the same mid-flush as it does after an hour stuck. The
  // marker is the missing WHEN: the start of the current unbroken run of
  // non-empty queue reports, i.e. when the buffer was last seen empty.
  //
  // Exactly three cases, and the third is the one that keeps this honest:
  //
  //   pending === 0   CLEAR to NULL, unconditionally. Idempotent, and it is
  //                   the only thing that can clear the marker, so a bridge
  //                   which drains even once is never left looking stuck.
  //   pending > 0     ARM, but only if it is not already armed — the marker
  //                   must record when the run STARTED, not when we last
  //                   looked, or it could never grow old enough to grade.
  //                   Done as its own conditional UPDATE below.
  //   no telemetry    TOUCH NOTHING. Same rule as the mig-531 columns: a
  //                   bridge on older software, an empty keepalive, or a
  //                   payload we could not parse says nothing about the queue.
  //                   Writing `now` there would invent a backlog on a bridge
  //                   that has never claimed to have one; writing NULL would
  //                   silently clear a real one on a single odd heartbeat.
  //
  // Note `pending` comes off the PARSED patch, not off `body` — parseBridge-
  // Telemetry has already clamped it to a non-negative int32 and handled the
  // flat/nested shapes, and reading the raw body here would be a second,
  // divergent parser for the same field.
  const pending = telemetry?.last_pending_samples
  if (pending === 0) updates.pending_stuck_since = null

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

  // The ARM half, as a separate statement because "set it only if it is not
  // already set" is not expressible in one supabase-js patch.
  //
  // `.is(..., null)` makes Postgres do the compare-and-set in ONE statement —
  // no read-modify-write, so two heartbeats racing cannot both stamp: the
  // second matches zero rows and leaves the first's timestamp alone. Reading
  // the row first and deciding in JS would have that race, and would cost a
  // round trip on EVERY heartbeat rather than only on the rare non-empty one.
  //
  // Best-effort by design: a failure here is logged and dropped. The heartbeat
  // has already succeeded, the bridge is not told, and the next tick (30s)
  // re-arms — a marker that is 30s late cannot matter to a 10-minute grade,
  // whereas failing the heartbeat over it would make a bridge look OFFLINE,
  // turning a missed alert into a fake outage.
  if (pending > 0) {
    const { error: markError } = await db
      .from('ble_bridges')
      .update({ pending_stuck_since: now })
      .eq('id', bridge.bridgeId)
      .is('pending_stuck_since', null)
    if (markError) {
      logWarn('bridge-heartbeat', 'failed to arm pending_stuck_since', {
        err: markError, bridgeId: bridge.bridgeId,
      })
    }
  }

  return NextResponse.json({
    ok: true,
    server_time: new Date().toISOString(),
  })
}
