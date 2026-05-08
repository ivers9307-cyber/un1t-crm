// POST /api/bridge/samples
//
// Bridge → server batched HR samples. Body:
//
//   {
//     samples: [
//       { strap_mac: "AA:BB:CC:DD:EE:FF", recorded_at: ISO, bpm: 145 },
//       ...
//     ]
//   }
//
// The bridge sends every sample it sees, paired or not. The server
// looks up the active strap_assignments for this bridge ONCE per
// request, builds a strap_mac → session_id map, and inserts only
// the matching samples into hr_samples.
//
// Unmatched samples are counted in the response stats but not
// stored. The bridge's separate /scan call surfaces those straps
// to the coach so they can be paired.
//
// Body cap: 1000 samples. Beyond that the bridge is sending too
// large a batch and should split. Returns 413.
//
// Idempotency: hr_samples PK is (session_id, recorded_at). Upsert
// with ignoreDuplicates so a network-blip retry is safe.

import { NextResponse } from 'next/server'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { createServerClient } from '@/lib/supabase'
import {
  resolveStrapsForBatch,
  buildHrSampleRows,
  insertHrSamples,
} from '@/lib/bridge-samples'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_SAMPLES_PER_REQUEST = 1000

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

  const samples = Array.isArray(body?.samples) ? body.samples : null
  if (!samples) {
    return NextResponse.json({ ok: false, error: 'missing_samples' }, { status: 400 })
  }
  if (samples.length > MAX_SAMPLES_PER_REQUEST) {
    return NextResponse.json({
      ok: false,
      error: 'batch_too_large',
      max: MAX_SAMPLES_PER_REQUEST,
    }, { status: 413 })
  }

  const db = createServerClient()
  // Resolve every MAC in the batch ONCE — checking the manual-override
  // strap_assignments path first, then falling through to the
  // contact_devices auto-association (which auto-creates a session
  // tied to the contact's in-progress booking when applicable).
  const macs = (samples || []).map((s) => s?.strap_mac).filter(Boolean)
  const strapMap = await resolveStrapsForBatch(db, {
    bridgeId: bridge.bridgeId,
    locationId: bridge.locationId,
    macs,
  })
  const { rows, stats } = buildHrSampleRows(samples, strapMap)

  let inserted = 0
  if (rows.length > 0) {
    const out = await insertHrSamples(db, rows)
    inserted = out.inserted
    if (out.error) {
      logWarn('bridge-samples', 'partial insert error — bridge will retry', {
        err: out.error,
        attempted: rows.length,
      })
    }
  }

  // Touch heartbeat opportunistically so we don't need a separate
  // ping when the bridge is actively sending samples.
  await db
    .from('ble_bridges')
    .update({ last_seen_at: new Date().toISOString(), status: 'online' })
    .eq('id', bridge.bridgeId)

  return NextResponse.json({
    ok: true,
    received: stats.received,
    accepted: stats.accepted,
    inserted,
    dropped_unpaired: stats.dropped_unpaired,
    dropped_invalid: stats.dropped_invalid,
    active_straps: strapMap.size,
  })
}
