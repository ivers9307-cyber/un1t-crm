// GET /api/bridge/inbody/backfill-pending
//
// On-demand single-member backfill (SP2 Phase 2b). When an operator clicks
// "Sync InBody" on a contact, a row is queued in inbody_backfill_requests. The
// on-site Pi polls this for pending requests, calls GetDateTimes(phone) →
// GetFullInBodyData per scan from the gym's whitelisted IP, and relays them to
// POST /api/bridge/inbody/backfill-ingest.
//
// Returns pending requests oldest-first, capped, with just the id + phone the
// Pi needs.
//
// Auth: bearer bridge token via verifyBridgeToken. Anything else → 401.

import { NextResponse } from 'next/server'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BATCH = 20

export async function GET(request) {
  const bridge = await verifyBridgeToken(request)
  if (!bridge) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('inbody_backfill_requests')
    .select('id, phone')
    .eq('status', 'pending')
    .order('requested_at', { ascending: true })
    .limit(BATCH)

  if (error) {
    logWarn('bridge-inbody-backfill-pending', 'query failed', { err: error, bridgeId: bridge.bridgeId })
    return NextResponse.json({ ok: false, error: 'query_failed' }, { status: 200 })
  }

  const pending = (data || []).map((r) => ({ request_id: r.id, phone: r.phone }))
  return NextResponse.json({ ok: true, pending })
}
