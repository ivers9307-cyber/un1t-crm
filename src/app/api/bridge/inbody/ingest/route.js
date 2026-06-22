// POST /api/bridge/inbody/ingest
//
// The on-site Pi relays the InBody REST API's GetFullInBodyData response for
// each pending scan it fetched (see GET /api/bridge/inbody/pending). This is
// where the CRM does all the brain-work: map the raw measurements into
// inbody_scans, match the phone to a contact, and mark the originating
// webhook event processed. The Pi never touches the DB or the matching logic.
//
// Body:     { results: [ { event_id: uuid, raw: object } ] }   (cap 50)
// Response: { ok: true, processed: n, linked: m }
//
// Idempotent: inbody_scans upserts on (source, external_id) and an already-
// processed event is skipped, so a re-sent batch is a no-op.
//
// Auth: bearer bridge token via verifyBridgeToken. Anything else → 401.

import { NextResponse } from 'next/server'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'
import { parseFullInBodyData } from '@/lib/inbody-scan'
import { inbodyDatetimeToIso } from '@/lib/inbody-webhook'
import { normalisePhone9 } from '@/lib/person-links'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SOURCE = 'lookinbody'
const MAX_RESULTS = 50

// Resolve the single contact whose phone matches `telHp` (last-9-digit), or
// null if there's no unambiguous match. Pre-filters with an ilike on the digit
// tail (the established phone-search pattern), then confirms with the
// format-agnostic normalisePhone9 and requires exactly one distinct contact.
async function matchContactId(db, telHp) {
  const tail = normalisePhone9(telHp)
  if (!tail) return null
  const { data, error } = await db
    .from('contacts')
    .select('id, phone, wa_phone')
    .or(`phone.ilike.%${tail}%,wa_phone.ilike.%${tail}%`)
    .limit(20)
  if (error || !data) return null
  const ids = new Set(
    data
      .filter((c) => normalisePhone9(c.phone) === tail || normalisePhone9(c.wa_phone) === tail)
      .map((c) => c.id),
  )
  return ids.size === 1 ? [...ids][0] : null
}

export async function POST(request) {
  const bridge = await verifyBridgeToken(request)
  if (!bridge) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  let body = {}
  try { body = await request.json() } catch { body = {} }
  const results = Array.isArray(body.results) ? body.results.slice(0, MAX_RESULTS) : []

  const db = createServerClient()
  let processed = 0
  let linked = 0

  for (const item of results) {
    const eventId = item?.event_id
    if (!eventId) continue
    try {
      const { data: event } = await db
        .from('inbody_webhook_events')
        .select('id, tel_hp, test_datetime, processed')
        .eq('id', eventId)
        .maybeSingle()
      if (!event || event.processed) continue

      const scannedAt = inbodyDatetimeToIso(event.test_datetime)
      if (!scannedAt || !event.tel_hp) continue // can't form a valid, idempotent scan

      const externalId = `${event.tel_hp}_${event.test_datetime}`
      const measurements = parseFullInBodyData(item.raw)
      const contactId = await matchContactId(db, event.tel_hp)

      const { error: upsertErr } = await db
        .from('inbody_scans')
        .upsert({
          source: SOURCE,
          external_id: externalId,
          location_id: bridge.locationId,
          contact_id: contactId,
          matched_phone: event.tel_hp,
          scanned_at: scannedAt,
          ...measurements,
          raw: item.raw ?? null,
        }, { onConflict: 'source,external_id' })
      if (upsertErr) {
        logWarn('bridge-inbody-ingest', 'scan upsert failed', { err: upsertErr, eventId })
        continue
      }

      await db
        .from('inbody_webhook_events')
        .update({
          processed: true,
          processed_at: new Date().toISOString(),
          matched_contact_id: contactId,
          location_id: bridge.locationId,
        })
        .eq('id', eventId)

      processed += 1
      if (contactId) linked += 1
    } catch (err) {
      logWarn('bridge-inbody-ingest', 'item failed', { err: err?.message || err, eventId })
    }
  }

  return NextResponse.json({ ok: true, processed, linked })
}
