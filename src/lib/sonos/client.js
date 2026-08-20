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
