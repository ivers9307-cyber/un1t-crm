// GET /api/cron/connection-health — daily grade of the connections
// registry (INTEG-A3). Applies the pure decideConnectionHealth()
// decision to every active channel_connections row: a token expiring
// within 10 days flips 'connected' → 'action_needed'; an already-dead
// token flips to 'error' (without clobbering a more specific
// last_error); a renewed token (the weekly instagram-token-refresh cron
// does the actual rolling) recovers rows this sweep flagged back to
// 'connected'. Feeds the upcoming Integrations hub — no user-visible
// surface reads these columns yet. defineCron owns the CRON_SECRET check
// and the heartbeat stamp. Heartbeat on a clean run only (a persist failure
// must surface as staleness; that run still answers 200 with the counts).

import { defineCron } from '@/lib/define-cron'
import { decideConnectionHealth } from '@/lib/connection-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'connection-health' }, async ({ db }) => {
  const { data: conns, error } = await db
    .from('channel_connections')
    .select('id, status, last_error, token_expires_at')
    .eq('is_active', true)
    // The un1t.online sync owns that row's status (its token is graded by
    // integration-health on tokenExpiresAt); grading it here too flapped it.
    .neq('platform', 'un1t_online')
  if (error) {
    console.error('[connection-health] fetch failed:', error.message)
    return { ok: false, body: { error: 'Could not read connections' } }
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

  const checked = (conns || []).length
  // A persist failure skips the stamp but answers 200, as it always has.
  if (failed > 0) return { ok: false, status: 200, body: { checked, updated, failed } }
  return { body: { checked, updated, failed }, outcome: { checked, updated } }
})
