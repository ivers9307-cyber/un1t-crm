// GET /api/cron/instagram-feed-sync — refresh each location's IG feed cache.
// Bearer CRON_SECRET. Per-location isolation: one studio's failure never blocks
// the others. Heartbeat on completion. (EVENTS-IG.1)
//
// defineCron owns the CRON_SECRET check, the error boundary and the heartbeat.
// An unreadable connections list answers 500 unstamped; a run where every
// connection failed (or none was usable) answers success with `stamp: false`,
// as it always has.
//
// A Graph failure that means the stored token is dead (401 / OAuthException,
// e.g. Meta invalidating the session after a password change) is also stamped
// on the connection row (status 'error' + last_error), so the Integrations
// hub says "reconnect Instagram" instead of showing it healthy while only the
// stale heartbeat pages. Transient failures don't flag the row.

import { defineCron } from '@/lib/define-cron'
import { syncLocationIgFeed } from '@/lib/instagram-feed'
import { isMetaAuthError, stampConnectionError } from '@/lib/connection-health'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'instagram-feed-sync' }, async ({ db }) => {
  const { data: conns, error: readErr } = await db
    .from('channel_connections')
    .select('id, location_id, external_account_id, access_token')
    .eq('platform', 'instagram')
    .eq('is_active', true)
  // A failed read is not "no connections": answering success here stamped the
  // heartbeat over an outage (audit 2026-11-15). No stamp, so it goes stale.
  if (readErr) {
    logError('instagram-feed-sync', 'connections read failed; no heartbeat', { code: readErr.code ?? null, message: readErr.message })
    return { ok: false, body: { error: 'Could not read Instagram connections' } }
  }

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
  return {
    stamp: ok > 0 || (conns || []).length === 0,
    body: { data: { locations: (conns || []).length, ok, failed } },
  }
})
