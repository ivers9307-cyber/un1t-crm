// Thin wrapper around Xero's REST + OAuth 2.0 API. We deliberately
// avoid the xero-node SDK — the API surface we use is small (Contacts,
// Invoices, Connections) and a hand-rolled fetch wrapper is easier to
// reason about, lighter on the bundle, and side-steps the SDK's
// constant version churn against Next.js.
//
// Token lifecycle
// ---------------
// access_token expires in ~30 min, refresh_token rotates on every
// refresh and is valid 60 days from last use. Every API call goes
// through withFreshToken() which:
//   1. Loads the connection row
//   2. Refreshes if expires_at < now + 60s
//   3. Persists the rotated tokens back to xero_connections
//   4. Hands the caller a Bearer-authenticated fetch helper
//
// All errors are surfaced as XeroError so callers can present a clean
// UI message without leaking token internals.

import { createServerClient } from '@/lib/supabase'

const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections'
const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize'
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0'

const REFRESH_BUFFER_MS = 60 * 1000 // refresh if access_token expires in <60s

// Scopes required for v1 (customer invoice push):
//   accounting.contacts            — find/create the buyer Contact
//   accounting.transactions        — POST the Invoice
//   offline_access                 — issue a refresh_token
//
// We deliberately omit the OIDC scopes (openid/profile/email) — we
// don't use the id_token for anything (the user is already
// authenticated against the CRM via Supabase Auth) and including
// them sometimes triggers Xero's `unauthorized_client / Invalid
// scope` error on apps that haven't explicitly enabled OIDC.
export const XERO_SCOPES = [
  'accounting.contacts',
  'accounting.transactions',
  'offline_access',
]

export class XeroError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message)
    this.name = 'XeroError'
    this.status = status
    this.body = body
    if (cause) this.cause = cause
  }
}

function envOrThrow(name) {
  const v = process.env[name]
  if (!v) {
    throw new XeroError(`Missing required env var: ${name}`)
  }
  return v
}

export function getXeroClientCreds() {
  return {
    clientId: envOrThrow('XERO_CLIENT_ID'),
    clientSecret: envOrThrow('XERO_CLIENT_SECRET'),
    redirectUri: envOrThrow('XERO_REDIRECT_URI'),
  }
}

// Build the authorize URL the user is redirected to. The `state`
// param round-trips back to /api/xero/callback so we can resume the
// flow at the right location and protect against CSRF.
export function buildAuthorizeUrl({ state }) {
  const { clientId, redirectUri } = getXeroClientCreds()
  const u = new URL(XERO_AUTHORIZE_URL)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('scope', XERO_SCOPES.join(' '))
  u.searchParams.set('state', state)
  return u.toString()
}

// Exchange the authorization code for the initial token set.
// Returns { access_token, refresh_token, expires_in, scope, ... }.
export async function exchangeAuthorizationCode(code) {
  const { clientId, clientSecret, redirectUri } = getXeroClientCreds()
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  })
  const res = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new XeroError(`Xero token exchange failed: ${res.status}`, { status: res.status, body: json })
  }
  return json
}

// Refresh an access_token. Xero rotates the refresh_token on every
// call — the new value MUST be persisted or future refreshes break.
export async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = getXeroClientCreds()
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const res = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new XeroError(`Xero token refresh failed: ${res.status}`, { status: res.status, body: json })
  }
  return json
}

// Pull the list of tenants this token has been granted. Called once
// straight after the code exchange so we know which tenant_id to
// persist on the connection row. The user picks one if multiple are
// returned (or we auto-select the only one).
export async function listConnectedTenants(accessToken) {
  const res = await fetch(XERO_CONNECTIONS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })
  const json = await res.json().catch(() => ([]))
  if (!res.ok) {
    throw new XeroError(`Xero /connections failed: ${res.status}`, { status: res.status, body: json })
  }
  return Array.isArray(json) ? json : []
}

// Load a stored connection for a location, refreshing the access_token
// if it's about to expire. Returns the row plus a `fetch(path, opts)`
// helper that prepends the API base, sets headers, and surfaces non-2xx
// responses as XeroError.
//
// Uses the service-role client so this works even from background
// jobs / API routes that don't have a user session.
export async function withFreshToken(locationId) {
  const db = createServerClient()
  const { data: conn, error } = await db
    .from('xero_connections')
    .select('*')
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) throw new XeroError(`Failed to load Xero connection: ${error.message}`)
  if (!conn) throw new XeroError('No Xero connection for this location. Connect Xero in Settings first.')

  const expiresAt = new Date(conn.expires_at).getTime()
  const needsRefresh = Number.isFinite(expiresAt) && expiresAt - Date.now() < REFRESH_BUFFER_MS

  let accessToken = conn.access_token
  let refreshToken = conn.refresh_token
  if (needsRefresh) {
    const refreshed = await refreshAccessToken(conn.refresh_token)
    accessToken = refreshed.access_token
    refreshToken = refreshed.refresh_token || conn.refresh_token
    const newExpiresAt = new Date(Date.now() + (refreshed.expires_in || 1800) * 1000).toISOString()
    const { error: upErr } = await db
      .from('xero_connections')
      .update({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: newExpiresAt,
      })
      .eq('id', conn.id)
    if (upErr) throw new XeroError(`Failed to persist refreshed Xero token: ${upErr.message}`)
  }

  // Authenticated fetch helper. `path` is appended to XERO_API_BASE.
  // Body is JSON-stringified if provided as an object.
  const xfetch = async (path, opts = {}) => {
    const url = path.startsWith('http') ? path : `${XERO_API_BASE}${path}`
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Xero-Tenant-Id': conn.tenant_id,
      Accept: 'application/json',
      ...(opts.headers || {}),
    }
    let body = opts.body
    if (body && typeof body === 'object' && !(body instanceof URLSearchParams) && !(body instanceof Buffer)) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json'
      body = JSON.stringify(body)
    }
    const res = await fetch(url, { ...opts, headers, body })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
    if (!res.ok) {
      const msg = json?.Detail || json?.Message || json?.detail || `Xero ${res.status} on ${path}`
      throw new XeroError(msg, { status: res.status, body: json || text })
    }
    return json
  }

  return { conn, xfetch }
}
