// POST /api/bridge/heartbeat
//
// Bridge keepalive. Updates ble_bridges.last_seen_at + status +
// software_version. Bridge calls this every ~30s while idle, and
// piggybacks status changes on samples + scan when active.
//
// Request body: { software_version?: string, status?: 'online' | 'error' }
// Response:     { ok: true, server_time: ISO } — server_time helps
//               the bridge spot clock skew (it warns if drift > 5min).
//
// Auth: bearer token via verifyBridgeToken. Anything else → 401.

import { NextResponse } from 'next/server'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { createServerClient } from '@/lib/supabase'
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

  const updates = {
    last_seen_at: new Date().toISOString(),
    status: 'online',
  }
  if (typeof body.software_version === 'string' && body.software_version.length < 64) {
    updates.software_version = body.software_version
  }
  if (body.status === 'error') updates.status = 'error'

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
