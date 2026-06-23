import { logWarn } from '@/lib/log'
import { refreshAccessToken, getActivity, listActivities } from '@/lib/strava'
import { mapStravaApiActivity } from '@/lib/strava-direct-map'

const REFRESH_MARGIN_MS = 120_000

export async function loadStravaConfig(db) {
  const { data } = await db
    .from('service_integrations')
    .select('client_id, client_secret, scopes, is_enabled')
    .eq('provider', 'strava')
    .maybeSingle()
  if (!data) return null
  return { clientId: data.client_id, clientSecret: data.client_secret, scopes: data.scopes || [], isEnabled: !!data.is_enabled }
}

export async function ensureFreshToken(db, connection, config) {
  const expMs = connection.expires_at ? Date.parse(connection.expires_at) : 0
  if (expMs - Date.now() > REFRESH_MARGIN_MS) return connection.access_token
  const fresh = await refreshAccessToken({
    clientId: config.clientId, clientSecret: config.clientSecret, refreshToken: connection.refresh_token,
  })
  await db.from('contact_external_integrations')
    .update({ access_token: fresh.accessToken, refresh_token: fresh.refreshToken, expires_at: fresh.expiresAt, last_error: null })
    .eq('id', connection.id)
  // keep the in-memory row current for subsequent calls in the same tick
  connection.access_token = fresh.accessToken
  connection.refresh_token = fresh.refreshToken
  connection.expires_at = fresh.expiresAt
  return fresh.accessToken
}

export async function ingestActivity(db, { connection, activityId, config }) {
  const token = await ensureFreshToken(db, connection, config)
  const activity = await getActivity({ accessToken: token, activityId })
  const row = mapStravaApiActivity({ contactId: connection.contact_id, activity, athleteId: connection.external_athlete_id })
  if (!row.strava_activity_id) return { skipped: 'no_id' }
  const { error } = await db.from('strava_activities').upsert(row, { onConflict: 'contact_id,strava_activity_id' })
  if (error) { logWarn('strava-import', 'upsert failed', { err: error, activityId }); return { skipped: 'upsert_failed' } }
  return { ingested: row.strava_activity_id }
}

export async function backfillConnection(db, { connection, config, sinceMs }) {
  const token = await ensureFreshToken(db, connection, config)
  const afterEpoch = Math.floor(sinceMs / 1000)
  const activities = await listActivities({ accessToken: token, afterEpoch, perPage: 100 })
  let n = 0
  for (const activity of activities || []) {
    const row = mapStravaApiActivity({ contactId: connection.contact_id, activity, athleteId: connection.external_athlete_id })
    if (!row.strava_activity_id) continue
    const { error } = await db.from('strava_activities').upsert(row, { onConflict: 'contact_id,strava_activity_id' })
    if (!error) n += 1
  }
  return { backfilled: n }
}
