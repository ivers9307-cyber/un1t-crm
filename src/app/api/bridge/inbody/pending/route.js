// GET /api/bridge/inbody/pending
//
// The on-site Pi (champ-bridge) polls this for InBody scan notifications that
// still need their measurements pulled. The webhook (POST /api/webhooks/inbody)
// captures each scan as a row in inbody_webhook_events with the phone
// (tel_hp) + scan datetime but NO measurements; the Pi fetches the actual
// body-composition data from the Lookin'Body REST API (from the gym's
// whitelisted IP) and relays it back to POST /api/bridge/inbody/ingest.
//
// Returns unprocessed events oldest-first, capped, with only the two fields
// the Pi needs to call GetFullInBodyData. Events missing tel_hp or
// test_datetime are skipped — they can't be fetched.
//
// Single-location note: Stillorgan is the only InBody account today, so the
// one Pi takes every unprocessed event and ingest stamps it with the bridge's
// location. When a second location gets InBody (2c), scope this by the
// bridge's configured account.
//
// Auth: bearer bridge token via verifyBridgeToken. Anything else → 401.

import { NextResponse } from 'next/server'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BATCH = 50

export async function GET(request) {
  const bridge = await verifyBridgeToken(request)
  if (!bridge) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('inbody_webhook_events')
    .select('id, tel_hp, test_datetime')
    .eq('processed', false)
    .not('tel_hp', 'is', null)
    .not('test_datetime', 'is', null)
    .order('received_at', { ascending: true })
    .limit(BATCH)

  if (error) {
    logWarn('bridge-inbody-pending', 'query failed', { err: error, bridgeId: bridge.bridgeId })
    return NextResponse.json({ ok: false, error: 'query_failed' }, { status: 200 })
  }

  const pending = (data || []).map((r) => ({
    event_id: r.id,
    usertoken: r.tel_hp,
    datetimes: r.test_datetime,
  }))

  return NextResponse.json({ ok: true, pending })
}
