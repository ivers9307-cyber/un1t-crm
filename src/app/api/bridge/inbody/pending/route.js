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
// LOCATION SCOPING (security audit W2-H / M1): inbody_webhook_events.location_id
// is NULL until ingest, so we CANNOT filter pending by it — that would return
// nothing. Each event carries `account` (the Lookin'Body account id); we scope
// to the accounts configured for the bridge's location
// (locations.settings.inbody.accounts). A bridge with no configured accounts
// gets an EMPTY queue — it must never be handed another location's scans.
//
// Auth: bearer bridge token via verifyBridgeToken. Anything else → 401.

import { NextResponse } from 'next/server'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'
import { bridgeInbodyScope, eventAccountMatchesScope, isPhoneShaped } from '@/lib/inbody-location-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BATCH = 50

export async function GET(request) {
  const bridge = await verifyBridgeToken(request)
  if (!bridge) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()

  // Resolve which InBody accounts this bridge's location owns. No config →
  // no accounts → empty queue (fail safe: never leak another location's scans).
  const scope = await bridgeInbodyScope(db, bridge)
  if (scope.accounts.size === 0) {
    logWarn('bridge-inbody-pending', 'no inbody accounts configured for location', {
      bridgeId: bridge.bridgeId,
      locationId: bridge.locationId,
    })
    return NextResponse.json({ ok: true, pending: [] })
  }

  // DB-side narrowing on `account` (normalised on capture, so `.in()` matches
  // exactly). `select('account')` too so we can re-verify the scope in app code
  // (defence-in-depth against any legacy row that predates capture-normalisation).
  const { data, error } = await db
    .from('inbody_webhook_events')
    .select('id, account, tel_hp, test_datetime')
    .eq('processed', false)
    .in('account', [...scope.accounts])
    .not('tel_hp', 'is', null)
    .not('test_datetime', 'is', null)
    .order('received_at', { ascending: true })
    .limit(BATCH)

  if (error) {
    logWarn('bridge-inbody-pending', 'query failed', { err: error, bridgeId: bridge.bridgeId })
    return NextResponse.json({ ok: false, error: 'query_failed' }, { status: 200 })
  }

  const pending = (data || [])
    // Re-check the account maps to this bridge's location (case-insensitive),
    // and only hand out phone-shaped usertokens — the Pi matches contacts by
    // phone, so a malformed tel_hp can't be fetched or trusted anyway.
    .filter((r) => eventAccountMatchesScope(r.account, scope) && isPhoneShaped(r.tel_hp))
    .map((r) => ({
      event_id: r.id,
      usertoken: r.tel_hp,
      datetimes: r.test_datetime,
    }))

  return NextResponse.json({ ok: true, pending })
}
