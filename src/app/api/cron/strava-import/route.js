import { defineCron } from '@/lib/define-cron'
import { logError, logWarn } from '@/lib/log'
import { loadStravaConfig, backfillConnection } from '@/lib/strava-import'

export const runtime = 'nodejs'
export const maxDuration = 300

const BACKFILL_DAYS = 30

export const GET = defineCron({ heartbeat: 'strava-import' }, async ({ db }) => {
  const config = await loadStravaConfig(db)
  if (!config?.isEnabled) return { body: { skipped: 'not_configured' } }

  // Connections that have the read scope but haven't been backfilled yet.
  const { data: pending, error: pendingError } = await db
    .from('contact_external_integrations')
    .select('id, contact_id, external_athlete_id, access_token, refresh_token, expires_at, scopes')
    .eq('provider', 'strava')
    .is('disconnected_at', null)
    .is('import_backfilled_at', null)
    .limit(50)
  // A failed read is not "nobody to backfill": the run did not happen.
  if (pendingError) {
    logError('cron.strava-import', 'pending connections read failed', { err: pendingError })
    return { ok: false, body: { error: 'Could not read connections' } }
  }

  const sinceMs = Date.now() - BACKFILL_DAYS * 24 * 3600 * 1000
  let done = 0
  for (const connection of pending || []) {
    const hasRead = (connection.scopes || []).some((s) => s === 'activity:read' || s === 'activity:read_all')
    if (!hasRead) continue
    try {
      await backfillConnection(db, { connection, config, sinceMs })
      const { error } = await db
        .from('contact_external_integrations')
        .update({ import_backfilled_at: new Date().toISOString() })
        .eq('id', connection.id)
      if (error) throw error
      done += 1
    } catch (err) {
      // One connection failing is retried next run; the run itself carries on.
      logWarn('cron.strava-import', 'backfill failed', { connection_id: connection.id, err })
    }
  }
  return { body: { backfilled_connections: done } }
})
