// GET /api/cron/instagram-token-refresh — roll Instagram Login tokens (IG-LOGIN).
// Instagram Login API tokens live ~60 days and are refreshable only while
// still valid and at least 24h old (Meta refuses expired or too-fresh
// tokens). A weekly roll keeps every active connection perpetually ~53+
// days from expiry, so a failed week (or a just-pasted token tripping the
// 24h rule) logs loudly but costs nothing — the stored token is never
// clobbered on failure. Bearer CRON_SECRET. Heartbeat on completion.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { buildTokenRefreshPatch } from '@/lib/agent/channels'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Documented as an unversioned endpoint (unlike the rest of the IG Graph
// surface): GET /refresh_access_token?grant_type=ig_refresh_token.
const REFRESH_URL = 'https://graph.instagram.com/refresh_access_token'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()
  const { data: conns } = await db
    .from('channel_connections')
    .select('id, location_id, access_token')
    .eq('platform', 'instagram')
    .eq('is_active', true)

  let refreshed = 0
  let failed = 0
  for (const conn of (conns || [])) {
    if (!conn.access_token) continue
    try {
      const res = await fetch(
        `${REFRESH_URL}?grant_type=ig_refresh_token&access_token=${encodeURIComponent(conn.access_token)}`
      )
      const json = await res.json().catch(() => ({}))
      const patch = res.ok ? buildTokenRefreshPatch(json) : null
      if (!patch) {
        failed += 1
        console.error(`[instagram-token-refresh] connection ${conn.id}: ${json?.error?.message || `HTTP ${res.status}`}`)
        continue
      }
      const { error } = await db.from('channel_connections').update(patch).eq('id', conn.id)
      if (error) {
        failed += 1
        console.error(`[instagram-token-refresh] connection ${conn.id}: persist failed — ${error.message}`)
        continue
      }
      refreshed += 1
    } catch (e) {
      failed += 1
      console.error(`[instagram-token-refresh] connection ${conn.id}: ${e.message}`)
    }
  }

  // Stamp ONLY on a fully clean run: persistent refresh failure must
  // surface as heartbeat staleness (the runbook's alarm) rather than
  // burn the 60-day runway behind a fresh stamp. A run with zero
  // token-bearing connections is clean — nothing to refresh is not a
  // failure, and skipping the stamp there would false-alarm forever.
  if (failed === 0) await stampHeartbeat('instagram-token-refresh', { refreshed, failed })
  return NextResponse.json({ success: true, refreshed, failed })
}
