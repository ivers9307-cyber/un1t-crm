// FLEET-ALERT.1 — minimal Tailscale API client for reading device reachability.
//
// The CRM has no network path to the Pis (Vercel is not on the tailnet), and
// the two kiosk Pis report nothing to the CRM at all. Tailscale's control
// plane already knows whether every device is connected, so reading it here
// gives whole-fleet visibility with ZERO device-side code.
//
// Read-only. This module never authorises, tags, or deletes a device.

const TOKEN_URL = 'https://api.tailscale.com/api/v2/oauth/token'
const API_BASE = 'https://api.tailscale.com/api/v2'

/** Is the Tailscale integration configured? Unset env = feature ships dark. */
export function tailscaleConfigured(env = process.env) {
  return Boolean(
    env.TAILSCALE_OAUTH_CLIENT_ID &&
      env.TAILSCALE_OAUTH_CLIENT_SECRET &&
      env.TAILSCALE_TAILNET,
  )
}

/**
 * Exchange the OAuth client credentials for an access token.
 * Tokens last one hour and cannot be extended, so we mint one per cron run
 * rather than caching across invocations (Vercel functions are ephemeral —
 * a cache would rarely be warm and would risk serving an expired token).
 */
async function getAccessToken(env, fetchImpl) {
  const body = new URLSearchParams({
    client_id: env.TAILSCALE_OAUTH_CLIENT_ID,
    client_secret: env.TAILSCALE_OAUTH_CLIENT_SECRET,
    grant_type: 'client_credentials',
  })

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    throw new Error(`tailscale oauth failed: ${res.status}`)
  }
  const json = await res.json()
  if (!json?.access_token) throw new Error('tailscale oauth returned no access_token')
  return json.access_token
}

/**
 * List every device on the tailnet.
 *
 * Each row carries `connectedToControl` (boolean). `lastSeen` is present ONLY
 * when connectedToControl is false — its absence on a connected device is the
 * healthy signal, not "never seen".
 *
 * @param {object} [opts]
 * @param {object} [opts.env]        defaults to process.env
 * @param {Function} [opts.fetchImpl] injected for tests
 * @returns {Promise<Array<object>>}
 */
export async function listTailnetDevices({ env = process.env, fetchImpl = fetch } = {}) {
  const token = await getAccessToken(env, fetchImpl)
  const tailnet = encodeURIComponent(env.TAILSCALE_TAILNET)

  const res = await fetchImpl(`${API_BASE}/tailnet/${tailnet}/devices`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error(`tailscale devices list failed: ${res.status}`)
  }
  const json = await res.json()
  return Array.isArray(json?.devices) ? json.devices : []
}
