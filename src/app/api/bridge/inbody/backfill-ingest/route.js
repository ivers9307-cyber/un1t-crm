// POST /api/bridge/inbody/backfill-ingest
//
// The Pi relays a member's full InBody history for one backfill request (see
// GET /api/bridge/inbody/backfill-pending): it called GetDateTimes(phone) then
// GetFullInBodyData per scan, and posts them all here. We land each into
// inbody_scans (shared ingestScan core — same map/match/upsert as the webhook
// path) and close the request with counts.
//
// Body:     { request_id: uuid, scans: [ { datetimes: string, raw: object } ], error?: string }
//           - scans present  → mark done (scans_found / scans_ingested)
//           - error present  → mark error (e.g. GetDateTimes 401 / IP not whitelisted)
// Response: { ok: true, found: n, ingested: m }
//
// Idempotent: inbody_scans upserts on (source, external_id); re-running a
// request just re-upserts the same rows.
//
// Auth: bearer bridge token via verifyBridgeToken. Anything else → 401.

import { NextResponse } from 'next/server'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'
import { ingestScan } from '@/lib/inbody-ingest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_SCANS = 200

export async function POST(request) {
  const bridge = await verifyBridgeToken(request)
  if (!bridge) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  let body = {}
  try { body = await request.json() } catch { body = {} }
  const requestId = body.request_id
  if (!requestId) {
    return NextResponse.json({ ok: false, error: 'request_id required' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: req } = await db
    .from('inbody_backfill_requests')
    .select('id, phone, status')
    .eq('id', requestId)
    .maybeSingle()
  if (!req) {
    return NextResponse.json({ ok: false, error: 'request not found' }, { status: 404 })
  }

  // The Pi couldn't list the member's scans (e.g. IP not whitelisted) — record
  // the failure so the operator sees it instead of a silent stuck "pending".
  if (body.error) {
    await db
      .from('inbody_backfill_requests')
      .update({ status: 'error', processed_at: new Date().toISOString(), error: String(body.error).slice(0, 500) })
      .eq('id', requestId)
    return NextResponse.json({ ok: true, found: 0, ingested: 0 })
  }

  const scans = Array.isArray(body.scans) ? body.scans.slice(0, MAX_SCANS) : []
  let ingested = 0
  for (const s of scans) {
    try {
      const result = await ingestScan(db, {
        telHp: req.phone,
        testDatetime: s?.datetimes,
        raw: s?.raw,
        locationId: bridge.locationId,
      })
      if (result.ok) ingested += 1
    } catch (err) {
      logWarn('bridge-inbody-backfill-ingest', 'scan failed', { err: err?.message || err, requestId })
    }
  }

  await db
    .from('inbody_backfill_requests')
    .update({
      status: 'done',
      processed_at: new Date().toISOString(),
      scans_found: scans.length,
      scans_ingested: ingested,
      location_id: bridge.locationId,
      error: null,
    })
    .eq('id', requestId)

  return NextResponse.json({ ok: true, found: scans.length, ingested })
}
