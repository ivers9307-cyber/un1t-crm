// GET /api/cron/connection-health — daily grade of the connections
// registry (INTEG-A3). Applies the pure decideConnectionHealth()
// decision to every active channel_connections row: a token expiring
// within 10 days flips 'connected' → 'action_needed'; an already-dead
// token flips to 'error' (without clobbering a more specific
// last_error); a renewed token (the weekly instagram-token-refresh cron
// does the actual rolling) recovers rows this sweep flagged back to
// 'connected'. Feeds the upcoming Integrations hub — no user-visible
// surface reads these columns yet. Bearer CRON_SECRET. Heartbeat on a
// clean run only (a persist failure must surface as staleness).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { decideConnectionHealth } from '@/lib/connection-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const { data: conns, error } = await db
    .from('channel_connections')
    .select('id, status, last_error, token_expires_at')
    .eq('is_active', true)
  if (error) {
    console.error('[connection-health] fetch failed:', error.message)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  let updated = 0
  let failed = 0
  for (const conn of (conns || [])) {
    const patch = decideConnectionHealth(conn)
    if (!patch) continue
    const { error: updateError } = await db.from('channel_connections').update(patch).eq('id', conn.id)
    if (updateError) {
      failed += 1
      console.error(`[connection-health] connection ${conn.id}: persist failed — ${updateError.message}`)
      continue
    }
    updated += 1
  }

  if (failed === 0) await stampHeartbeat('connection-health', { checked: (conns || []).length, updated })
  return NextResponse.json({ success: true, checked: (conns || []).length, updated, failed })
}
