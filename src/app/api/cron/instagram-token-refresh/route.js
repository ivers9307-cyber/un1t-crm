// GET /api/cron/instagram-token-refresh — roll Instagram Login tokens (IG-LOGIN).
// Instagram Login API tokens live ~60 days and are refreshable only while
// still valid and at least 24h old (Meta refuses expired or too-fresh
// tokens). A weekly roll keeps every active connection perpetually ~53+
// days from expiry, so a failed week (or a just-pasted token tripping the
// 24h rule) logs loudly but costs nothing — the stored token is never
// clobbered on failure. defineCron owns the CRON_SECRET check, the
// service-role client and the heartbeat stamp, which lands only on a fully
// clean run (see the end of GET).

import { defineCron } from '@/lib/define-cron'
import { buildTokenRefreshPatch } from '@/lib/agent/channels'
import { isMetaAuthError, stampConnectionError } from '@/lib/connection-health'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// The platform default it always ran on, now declared.
export const maxDuration = 300

// Documented as an unversioned endpoint (unlike the rest of the IG Graph
// surface): GET /refresh_access_token?grant_type=ig_refresh_token.
const REFRESH_URL = 'https://graph.instagram.com/refresh_access_token'

export const GET = defineCron({ heartbeat: 'instagram-token-refresh' }, async ({ db }) => {
  const { data: conns, error: readErr } = await db
    .from('channel_connections')
    .select('id, location_id, access_token')
    .eq('platform', 'instagram')
    .eq('is_active', true)
  // A failed read is not "nothing to refresh": with conns null the loop ran
  // zero times, failed stayed 0 and the heartbeat was stamped over an outage
  // while tokens could expire (audit 2026-11-15). No stamp, so it goes stale.
  if (readErr) {
    logError('instagram-token-refresh', 'connections read failed; no heartbeat', { code: readErr.code ?? null, message: readErr.message })
    return { ok: false, body: { error: 'Could not read Instagram connections' } }
  }

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
        const reason = json?.error?.message || `HTTP ${res.status}`
        logError('instagram-token-refresh', 'token refresh refused', { connection_id: conn.id, status: res.status, reason })
        // A dead token is the studio's to fix: say so on the connection row, as
        // instagram-feed-sync does, so the Integrations hub shows "reconnect"
        // instead of an anonymous stale heartbeat being the only signal.
        if (isMetaAuthError(json?.error, res.status)) {
          await stampConnectionError(db, conn.id, `Instagram refused to refresh the access token; reconnect it (generate a new token in the Meta console). ${reason}`)
        }
        continue
      }
      const { error } = await db.from('channel_connections').update(patch).eq('id', conn.id)
      if (error) {
        failed += 1
        logError('instagram-token-refresh', 'refreshed token not saved', { connection_id: conn.id, code: error.code ?? null, message: error.message })
        continue
      }
      refreshed += 1
    } catch (e) {
      failed += 1
      logError('instagram-token-refresh', 'token refresh threw', { connection_id: conn.id, err: e })
    }
  }

  // Stamp ONLY on a fully clean run: persistent refresh failure must
  // surface as heartbeat staleness (the runbook's alarm) rather than
  // burn the 60-day runway behind a fresh stamp. A run with zero
  // token-bearing connections is clean — nothing to refresh is not a
  // failure, and skipping the stamp there would false-alarm forever. A run
  // with failures still answers 200, as it always has, now with success:false.
  if (failed > 0) return { ok: false, status: 200, body: { refreshed, failed } }
  return { body: { refreshed, failed }, outcome: { refreshed, failed } }
})
