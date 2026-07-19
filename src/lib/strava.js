// Minimal Strava API client. Just enough to:
//
//   1. Exchange OAuth code → tokens (used by the OAuth callback)
//   2. Refresh expired access tokens (the worker hot-path)
//   3. Upload an activity as TCX (multipart upload + status poll)
//
// Reads service_integrations.client_id / client_secret at call time
// so admins can rotate without redeploying. The provider must be
// is_enabled — callers should check that before invoking.
//
// SAAS-6 DECISION: service_integrations (mig 118) is deliberately
// PLATFORM-WIDE, not per-organization — Strava is one OAuth app for
// the whole deployment (per-tenant would require each gym to register
// its own Strava developer app, and Strava's ToS excludes the API
// from SaaS resale regardless). Don't add a tenant dimension here.
//
// All functions throw on non-2xx responses; the worker catches
// errors and writes them to external_export_jobs.last_error.

import { logWarn } from '@/lib/log'

const STRAVA_AUTH_URL  = 'https://www.strava.com/oauth/authorize'
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token'
const STRAVA_API_BASE  = 'https://www.strava.com/api/v3'

/**
 * Build the URL the member's browser is redirected to in order to
 * grant us access. Caller adds `state` (CSRF + return-path token).
 */
export function buildAuthorizeUrl({ clientId, redirectUri, scopes, state }) {
  const u = new URL(STRAVA_AUTH_URL)
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('approval_prompt', 'auto')
  u.searchParams.set('scope', (scopes || ['activity:write', 'read']).join(','))
  if (state) u.searchParams.set('state', state)
  return u.toString()
}

/**
 * Exchange the auth code from the callback for tokens. Strava
 * returns athlete profile inline so we can capture the athlete_id
 * in one round-trip.
 */
export async function exchangeCode({ clientId, clientSecret, code }) {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Strava token exchange failed: ${res.status} ${txt.slice(0, 200)}`)
  }
  const json = await res.json()
  return {
    accessToken:  json.access_token,
    refreshToken: json.refresh_token,
    expiresAt:    new Date(json.expires_at * 1000).toISOString(),
    athleteId:    json.athlete?.id ? String(json.athlete.id) : null,
    scopes:       (json.scope || '').split(',').filter(Boolean),
  }
}

/**
 * Trade a refresh_token for a fresh access_token. Strava returns
 * a new refresh_token too — store both back.
 */
export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Strava refresh failed: ${res.status} ${txt.slice(0, 200)}`)
  }
  const json = await res.json()
  return {
    accessToken:  json.access_token,
    refreshToken: json.refresh_token,
    expiresAt:    new Date(json.expires_at * 1000).toISOString(),
  }
}

/**
 * POST /api/v3/uploads with a TCX body. Strava processes async, so
 * we then poll GET /uploads/{id} until the activity_id is set or
 * the upload errors. Returns the activity_id on success.
 */
export async function uploadTcx({ accessToken, tcxXml, name = 'UN1T HR session', description = '' }) {
  const blob = new Blob([tcxXml], { type: 'application/xml' })
  const form = new FormData()
  form.append('file', blob, 'session.tcx')
  form.append('data_type', 'tcx')
  form.append('name', name)
  if (description) form.append('description', description)
  form.append('external_id', `un1t-${Date.now()}`)

  const res = await fetch(`${STRAVA_API_BASE}/uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    body: form,
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Strava upload failed: ${res.status} ${txt.slice(0, 200)}`)
  }
  const json = await res.json()
  // Activity ID may not be populated yet — Strava processes async.
  // The worker polls a few times before giving up; persistent
  // unprocessed status surfaces as last_error for investigation.
  if (json.activity_id) return { activityId: String(json.activity_id), uploadId: String(json.id) }
  return { activityId: null, uploadId: String(json.id), status: json.status, error: json.error }
}

/**
 * Polls /uploads/{id} until activity_id appears. Up to ~12s.
 * Returns the resolved activity_id or throws.
 */
export async function pollUpload({ accessToken, uploadId, maxAttempts = 6, gapMs = 2000 }) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, gapMs))
    const res = await fetch(`${STRAVA_API_BASE}/uploads/${uploadId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      logWarn('strava', 'poll non-2xx', { uploadId, status: res.status })
      continue
    }
    const json = await res.json()
    if (json.activity_id) return String(json.activity_id)
    if (json.error) throw new Error(`Strava upload error: ${json.error}`)
  }
  throw new Error('Strava upload still processing after polling window')
}

/**
 * Fetch a single DETAILED activity (includes `calories`). Throws on non-2xx.
 */
export async function getActivity({ accessToken, activityId }) {
  const res = await fetch(`${STRAVA_API_BASE}/activities/${encodeURIComponent(activityId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Strava activity fetch failed: ${res.status} ${txt.slice(0, 200)}`)
  }
  return res.json()
}

/**
 * List the athlete's SUMMARY activities (for backfill). `afterEpoch` is a Unix
 * seconds lower bound. `page` is 1-based (Strava paginates `/athlete/activities`
 * via page + per_page). Returns the array as-is. Throws on non-2xx.
 */
export async function listActivities({ accessToken, afterEpoch, perPage = 100, page = 1 }) {
  const u = new URL(`${STRAVA_API_BASE}/athlete/activities`)
  if (afterEpoch) u.searchParams.set('after', String(afterEpoch))
  u.searchParams.set('per_page', String(perPage))
  u.searchParams.set('page', String(page))
  const res = await fetch(u.toString(), { headers: { authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Strava activities list failed: ${res.status} ${txt.slice(0, 200)}`)
  }
  return res.json()
}
