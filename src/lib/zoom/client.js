// ZOOMSYNC.1 — Zoom Server-to-Server OAuth + a thin fetch wrapper.
//
// Ships dark: with any of the four required env vars unset, zoomConfigured() is false
// and callers no-op rather than erroring.

const TOKEN_URL = 'https://zoom.us/oauth/token'
const API_BASE = 'https://api.zoom.us/v2'
const TIMEOUT_MS = 15_000
const EXPIRY_SKEW_MS = 60_000 // refresh a minute early

let tokenCache = { token: null, expiresAt: 0 }

/** Test-only. Vitest shares module state across cases in a file. */
export function __resetTokenCache() {
  tokenCache = { token: null, expiresAt: 0 }
}

export function zoomConfigured() {
  return Boolean(
    process.env.ZOOM_ACCOUNT_ID &&
    process.env.ZOOM_CLIENT_ID &&
    process.env.ZOOM_CLIENT_SECRET &&
    // ZOOMSYNC.2 — the tenant boundary is a precondition for running at all,
    // not a runtime option. Without it there is no safe read of `contacts`, so
    // an unset value must ship dark exactly like a missing credential:
    // "configured" means "safe to run", not "has credentials".
    process.env.ZOOM_SYNC_ORGANIZATION_ID
  )
}

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token

  const basic = Buffer
    .from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`)
    .toString('base64')
  const url = `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(process.env.ZOOM_ACCOUNT_ID)}`

  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`zoom token ${resp.status}: ${text.slice(0, 200)}`)

  const body = JSON.parse(text)
  tokenCache = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - EXPIRY_SKEW_MS,
  }
  return tokenCache.token
}

/**
 * @returns {Promise<{ok: true, status: number, body: any} | {ok: false, status: number, error: string, body: any}>}
 * Never throws for HTTP-level failures — callers branch on `.ok`. Only a
 * network/token failure throws.
 */
export async function zoomFetch(path, { method = 'GET', body, _retried = false } = {}) {
  const token = await getToken()
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const text = await resp.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }

  if (resp.status === 429 && !_retried) {
    const wait = Number(resp.headers.get('retry-after') ?? 1)
    await new Promise((r) => setTimeout(r, Math.min(Math.max(wait, 0), 30) * 1000))
    return zoomFetch(path, { method, body, _retried: true })
  }

  // A 401 after a cached token means the token died early — drop it so the
  // single retry re-mints rather than replaying the dead one.
  if (resp.status === 401 && !_retried) {
    __resetTokenCache()
    return zoomFetch(path, { method, body, _retried: true })
  }

  if (!resp.ok) {
    return { ok: false, status: resp.status, error: text.slice(0, 300), body: parsed }
  }
  return { ok: true, status: resp.status, body: parsed }
}
