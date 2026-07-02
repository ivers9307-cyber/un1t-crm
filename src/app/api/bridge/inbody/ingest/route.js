// POST /api/bridge/inbody/ingest
//
// The on-site Pi relays the InBody REST API's GetFullInBodyData response for
// each pending scan it fetched (see GET /api/bridge/inbody/pending). This is
// where the CRM does all the brain-work: map the raw measurements into
// inbody_scans, match the phone to a contact, and mark the originating
// webhook event processed. The Pi never touches the DB or the matching logic.
//
// Body:     { results: [ { event_id: uuid, raw: object } ] }   (cap 50)
// Response: { ok: true, processed: n, linked: m, rejected: k }
//
// Idempotent: inbody_scans upserts on (source, external_id) and an already-
// processed event is skipped, so a re-sent batch is a no-op.
//
// LOCATION SCOPING (security audit W2-H / M1): each event's `account` must map
// to THIS bridge's location (locations.settings.inbody.accounts) — a bridge for
// location A cannot ingest / claim location B's scan. Rejected events are
// counted in `rejected` and left unprocessed.
//
// Auth: bearer bridge token via verifyBridgeToken. Anything else → 401.

import { NextResponse } from 'next/server'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'
import { ingestScan } from '@/lib/inbody-ingest'
import { bridgeInbodyScope, eventAccountMatchesScope, isPhoneShaped } from '@/lib/inbody-location-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_RESULTS = 50

export async function POST(request) {
  const bridge = await verifyBridgeToken(request)
  if (!bridge) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  let body = {}
  try { body = await request.json() } catch { body = {} }
  const results = Array.isArray(body.results) ? body.results.slice(0, MAX_RESULTS) : []

  const db = createServerClient()

  // The accounts this bridge's location owns — used to reject any event that
  // belongs to another location (security audit W2-H / M1). No config → no
  // accounts → every event is rejected (fail safe).
  const scope = await bridgeInbodyScope(db, bridge)

  let processed = 0
  let linked = 0
  let rejected = 0

  for (const item of results) {
    const eventId = item?.event_id
    if (!eventId) continue
    try {
      const { data: event } = await db
        .from('inbody_webhook_events')
        .select('id, account, tel_hp, test_datetime, processed')
        .eq('id', eventId)
        .maybeSingle()
      if (!event || event.processed) continue

      // Cross-location guard: a bridge must not ingest another location's scan.
      // The event's `account` must map to THIS bridge's location.
      if (!eventAccountMatchesScope(event.account, scope)) {
        rejected += 1
        logWarn('bridge-inbody-ingest', 'rejected cross-location event', {
          eventId, eventAccount: event.account, bridgeId: bridge.bridgeId, locationId: bridge.locationId,
        })
        continue
      }

      // Don't trust a non-phone-shaped tel_hp for contact matching.
      if (!isPhoneShaped(event.tel_hp)) {
        rejected += 1
        logWarn('bridge-inbody-ingest', 'rejected non-phone tel_hp', { eventId, bridgeId: bridge.bridgeId })
        continue
      }

      const result = await ingestScan(db, {
        telHp: event.tel_hp,
        testDatetime: event.test_datetime,
        raw: item.raw,
        locationId: bridge.locationId,
      })
      if (!result.ok) {
        if (result.reason === 'upsert_failed') {
          logWarn('bridge-inbody-ingest', 'scan upsert failed', { err: result.error, eventId })
        }
        continue // bad_input / upsert_failed → leave unprocessed for a later retry
      }

      await db
        .from('inbody_webhook_events')
        .update({
          processed: true,
          processed_at: new Date().toISOString(),
          matched_contact_id: result.contactId,
          location_id: bridge.locationId,
        })
        .eq('id', eventId)

      processed += 1
      if (result.linked) linked += 1
    } catch (err) {
      logWarn('bridge-inbody-ingest', 'item failed', { err: err?.message || err, eventId })
    }
  }

  return NextResponse.json({ ok: true, processed, linked, rejected })
}
