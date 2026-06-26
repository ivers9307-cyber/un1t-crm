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

// Backfill an athlete's recent Strava activities. AUDIT P1-2 — this is an
// EXTERNAL-API fan-out (not a Supabase select), so selectAll doesn't apply:
// the Strava activities endpoint returns at most `perPage` per call, so a
// single fetch silently capped the backfill at 100 activities. Page through
// (1-based) while a full page comes back — a short page means we've reached
// the end of the window. Capped at MAX_PAGES so a misconfigured `sinceMs`
// (e.g. epoch 0) can't walk the athlete's entire history / exhaust the rate
// limit; 10 × 100 = 1000 activities is plenty for any realistic reconnect.
const BACKFILL_PER_PAGE = 100
const BACKFILL_MAX_PAGES = 10

export async function backfillConnection(db, { connection, config, sinceMs }) {
  const token = await ensureFreshToken(db, connection, config)
  const afterEpoch = Math.floor(sinceMs / 1000)
  let n = 0
  for (let page = 1; page <= BACKFILL_MAX_PAGES; page += 1) {
    const activities = await listActivities({
      accessToken: token, afterEpoch, perPage: BACKFILL_PER_PAGE, page,
    })
    const batch = activities || []
    for (const activity of batch) {
      const row = mapStravaApiActivity({ contactId: connection.contact_id, activity, athleteId: connection.external_athlete_id })
      if (!row.strava_activity_id) continue
      const { error } = await db.from('strava_activities').upsert(row, { onConflict: 'contact_id,strava_activity_id' })
      if (!error) n += 1
    }
    // A page shorter than the requested size is the last page.
    if (batch.length < BACKFILL_PER_PAGE) break
  }
  return { backfilled: n }
}
