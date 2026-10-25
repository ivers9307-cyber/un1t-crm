// GET /api/cron/instagram-feed-sync — refresh each location's IG feed cache.
// Bearer CRON_SECRET. Per-location isolation: one studio's failure never blocks
// the others. Heartbeat on completion. (EVENTS-IG.1)
//
// A Graph failure that means the stored token is dead (401 / OAuthException,
// e.g. Meta invalidating the session after a password change) is also stamped
// on the connection row (status 'error' + last_error), so the Integrations
// hub says "reconnect Instagram" instead of showing it healthy while only the
// stale heartbeat pages. Transient failures don't flag the row.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { syncLocationIgFeed } from '@/lib/instagram-feed'
import { isMetaAuthError, stampConnectionError } from '@/lib/connection-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()
  const { data: conns } = await db
    .from('channel_connections')
    .select('id, location_id, external_account_id, access_token')
    .eq('platform', 'instagram')
    .eq('is_active', true)

  let ok = 0
  let failed = 0
  for (const conn of (conns || [])) {
    if (!conn.external_account_id || !conn.access_token) continue
    try {
      await syncLocationIgFeed({ db, connection: conn })
      ok += 1
    } catch (e) {
      failed += 1
      console.error(`[instagram-feed-sync] location ${conn.location_id}: ${e.message}`)
      if (isMetaAuthError(e.graphError, e.status)) {
        const reason = e.graphError?.message || `HTTP ${e.status}`
        await stampConnectionError(db, conn.id, `Instagram rejected the access token; reconnect it (generate a new token in the Meta console). ${reason}`)
      }
    }
  }
  // Heartbeat only on overall success: if there were connections and EVERY one
  // failed, skip the stamp so the stale-cron watcher surfaces the systemic
  // outage. No connections = nothing to do = success.
  if (ok > 0 || (conns || []).length === 0) {
    await stampHeartbeat('instagram-feed-sync')
  }
  return NextResponse.json({ success: true, data: { locations: (conns || []).length, ok, failed } })
}
