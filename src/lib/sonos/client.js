// SONOS.3 — Sonos Control API config + I/O.
//
// Config is tri-state, matching the Homey client this replaces:
//   - DORMANT (all three env vars unset) — the feature isn't turned on for
//     this deploy. getSonosConfig() returns null; the cron stamps its
//     heartbeat and exits quietly. Must NEVER page: every deploy runs the
//     cron before anyone registers the integration.
//   - MISCONFIGURED (some set, or a value fails validation) — someone
//     started and got it wrong. Returns { error }; the cron logs it loudly
//     every tick, because a silent dormant-looking failure is exactly the
//     bug nobody notices until "why didn't the music come on".
//   - CONFIGURED — returns the credentials.
//
// The client secret must never appear in a log line or a thrown error.
// Every error path below names the env var, never its value.

const OAUTH_AUTHORIZE_URL = 'https://api.sonos.com/login/v3/oauth'
const OAUTH_TOKEN_URL = 'https://api.sonos.com/login/v3/oauth/access'
const API_BASE = 'https://api.ws.sonos.com/control/api/v1'
const REQUEST_TIMEOUT_MS = 8000
const REFRESH_MARGIN_MS = 5 * 60 * 1000

// Sonos names a missing User-Agent as a throttling trigger.
const USER_AGENT = 'un1t-crm/1.0 (+https://crm.repset.ie)'

const isBlank = (v) => v === undefined || v === null || String(v).trim() === ''

export { OAUTH_AUTHORIZE_URL, OAUTH_TOKEN_URL, API_BASE }

// Pure + exported for tests. null = fully unset (dormant) OR fully valid.
export function sonosConfigError(env) {
  const raw = {
    SONOS_CLIENT_ID: env.SONOS_CLIENT_ID,
    SONOS_CLIENT_SECRET: env.SONOS_CLIENT_SECRET,
    SONOS_REDIRECT_URI: env.SONOS_REDIRECT_URI,
  }
  const missing = Object.keys(raw).filter((k) => isBlank(raw[k]))

  if (missing.length === 3) return null // dormant, not an error
  if (missing.length > 0) {
    return `Sonos is half-configured — missing ${missing.join(', ')} (set all three env vars, or none)`
  }

  let u
  try {
    u = new URL(String(raw.SONOS_REDIRECT_URI).trim())
  } catch {
    return 'SONOS_REDIRECT_URI is not a valid URL'
  }
  // Sonos requires the redirect to be HTTPS and publicly routable, and to
  // match the integration manager entry exactly.
  if (u.protocol !== 'https:') {
    return 'SONOS_REDIRECT_URI must be HTTPS and publicly routable (Sonos rejects http and localhost)'
  }

  return null
}

export function getSonosConfig(env = process.env) {
  const err = sonosConfigError(env)
  if (err) return { error: err }

  const allUnset =
    isBlank(env.SONOS_CLIENT_ID) && isBlank(env.SONOS_CLIENT_SECRET) && isBlank(env.SONOS_REDIRECT_URI)
  if (allUnset) return null

  return {
    clientId: String(env.SONOS_CLIENT_ID).trim(),
    clientSecret: String(env.SONOS_CLIENT_SECRET).trim(),
    redirectUri: String(env.SONOS_REDIRECT_URI).trim(),
  }
}

export function buildAuthorizeUrl(cfg, state) {
  const u = new URL(OAUTH_AUTHORIZE_URL)
  u.searchParams.set('client_id', cfg.clientId)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', 'playback-control-all')
  u.searchParams.set('redirect_uri', cfg.redirectUri)
  u.searchParams.set('state', state)
  return u.toString()
}

// Sonos wants the client credentials as HTTP Basic, never in the form body.
function basicAuth(cfg) {
  return `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`
}

async function tokenCall(cfg, params) {
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: basicAuth(cfg),
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
    let parsed = null
    const text = await res.text().catch(() => '')
    if (text) { try { parsed = JSON.parse(text) } catch { parsed = null } }
    return { ok: res.ok, statusCode: res.status, body: parsed }
  } catch {
    return { ok: false, statusCode: 0, networkError: true, body: null }
  }
}

export function exchangeCode(cfg, code) {
  return tokenCall(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  })
}

// Sonos does NOT rotate refresh tokens — the same value comes back every
// time. So callers persist only the access token and its expiry; there is
// no rotation race to guard against (unlike xero_connections).
export function refreshAccessToken(cfg, refreshToken) {
  return tokenCall(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken })
}

// Never throws. Always resolves to { ok, statusCode, body }, or
// { ok: false, statusCode: 0, networkError: true, body: null } on a
// network/timeout failure — a reconcile tick must not blow up because the
// studio's line dropped.
async function apiCall(token, method, path, body) {
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': USER_AGENT,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
    let parsed = null
    const text = await res.text().catch(() => '')
    if (text) { try { parsed = JSON.parse(text) } catch { parsed = null } }
    return { ok: res.ok, statusCode: res.status, body: parsed }
  } catch {
    return { ok: false, statusCode: 0, networkError: true, body: null }
  }
}

const enc = (s) => encodeURIComponent(String(s))

export function sonosGetHouseholds(token) {
  return apiCall(token, 'GET', '/households')
}

// One call returns groups, players AND each group's playbackState — the
// whole read side of a reconcile tick.
export function sonosGetGroups(token, householdId) {
  return apiCall(token, 'GET', `/households/${enc(householdId)}/groups`)
}

export function sonosGetFavorites(token, householdId) {
  return apiCall(token, 'GET', `/households/${enc(householdId)}/favorites`)
}

export function sonosSetGroupVolume(token, groupId, volume) {
  // Sonos rejects >100 outright and reads any negative as 0. Clamp here so
  // a bad stored value is a quiet no-op rather than a 400 that aborts the
  // window and leaves the favourite unloaded.
  const v = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)))
  return apiCall(token, 'POST', `/groups/${enc(groupId)}/groupVolume`, { volume: v })
}

export function sonosLoadFavorite(token, groupId, favoriteId) {
  return apiCall(token, 'POST', `/groups/${enc(groupId)}/favorites`, {
    favoriteId: String(favoriteId),
    playOnCompletion: true,
  })
}

export function sonosPause(token, groupId) {
  return apiCall(token, 'POST', `/groups/${enc(groupId)}/playback/pause`)
}

// Loads a location's connection and returns a usable access token,
// refreshing first if it is inside the margin. Never throws — every
// failure is a tagged result the caller can act on, because the two
// callers are a cron tick (log and move on) and a UI route (prompt a
// re-link).
export async function withFreshToken(db, locationId, cfg) {
  const { data: conn, error } = await db
    .from('sonos_connections')
    .select('*')
    .eq('location_id', locationId)
    .maybeSingle()

  if (error) return { ok: false, reason: 'db_error', message: error.message }
  if (!conn) return { ok: false, reason: 'not_connected' }

  const expiresAt = new Date(conn.access_token_expires_at || 0).getTime()
  const fresh = Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_MARGIN_MS
  if (fresh && conn.access_token) {
    return { ok: true, token: conn.access_token, householdId: conn.household_id, connection: conn }
  }

  const refreshed = await refreshAccessToken(cfg, conn.refresh_token)
  if (!refreshed.ok || !refreshed.body?.access_token) {
    return { ok: false, reason: 'refresh_failed', statusCode: refreshed.statusCode }
  }

  const token = refreshed.body.access_token
  const newExpiry = new Date(Date.now() + (refreshed.body.expires_in || 86400) * 1000).toISOString()

  // Only the access token and its expiry are persisted. Sonos returns the
  // SAME refresh token every time, so rewriting it would be a no-op that
  // buys a read-modify-write race for nothing.
  const { error: upErr } = await db
    .from('sonos_connections')
    .update({ access_token: token, access_token_expires_at: newExpiry, updated_at: new Date().toISOString() })
    .eq('id', conn.id)
  if (upErr) return { ok: false, reason: 'db_error', message: upErr.message }

  return { ok: true, token, householdId: conn.household_id, connection: conn }
}
