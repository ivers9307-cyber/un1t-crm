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
//   accounting.invoices            — POST the Invoice (granular scope)
//   offline_access                 — issue a refresh_token
//
// IMPORTANT: as of 2 March 2026 Xero replaced the broad
// `accounting.transactions` scope with granular scopes. Apps
// created on/after that date cannot request the broad scope at all
// and Xero rejects auth with `unauthorized_client / Invalid scope
// for client`. The granular replacement for invoice endpoints is
// `accounting.invoices` (covers invoices, credit notes, items,
// purchase orders, quotes, repeating invoices, linked transactions).
//
// `accounting.contacts` is unchanged and still valid for both old
// and new apps. OIDC scopes (openid/profile/email) are omitted —
// we don't use the id_token (auth is via Supabase) and including
// them is another common cause of the same Xero error.
//
// Reference: https://www.apideck.com/blog/xero-scopes
//
// `accounting.attachments` is REQUIRED to upload the source invoice
// document onto the draft bill (POST /Invoices/{id}/Attachments).
// Creating the bill only needs `accounting.invoices`, so without this
// the create succeeds but the attachment is refused with
// `AuthorizationUnsuccessful`. (We don't need the broader `files`
// scope — that's the org-level Files Inbox, a different surface.)
// NOTE: adding a scope means existing connections must RECONNECT Xero
// (Settings → Integrations → reconnect) before the new grant applies.
export const XERO_SCOPES = [
  'accounting.contacts',
  'accounting.invoices',
  'accounting.attachments',  // upload source doc onto the bill
  'accounting.settings',     // GET /BrandingThemes for the "Car" theme
  'offline_access',
]

// Xero validation failures return a generic top-level Message
// ("A validation exception occurred") with the ACTUAL reason nested
// under Elements[].ValidationErrors[].Message (e.g. "Currency GBP is
// not added to your organisation", duplicate invoice number, archived
// account). Flatten those so the operator sees WHY the bill was
// rejected instead of a useless generic string. Pure + exported for
// unit testing.
export function flattenXeroValidationErrors(json) {
  if (!json || !Array.isArray(json.Elements)) return []
  const out = []
  for (const el of json.Elements) {
    for (const v of (el && el.ValidationErrors) || []) {
      if (v && v.Message) out.push(v.Message)
    }
  }
  return [...new Set(out)]
}

export class XeroError extends Error {
  constructor(message, { status, body, cause, code } = {}) {
    super(message)
    this.name = 'XeroError'
    this.status = status
    this.body = body
    this.code = code  // machine-readable tag, e.g. 'already_in_xero'
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
  // Force the consent screen on every (re)connect. Without this, a user
  // who already authorised the app under an OLDER scope set is silently
  // re-issued a token with the PREVIOUS scopes — so a newly-added scope
  // (e.g. accounting.attachments) never gets granted just by clicking
  // "reconnect". prompt=consent makes Xero re-present + grant the full
  // current XERO_SCOPES list.
  u.searchParams.set('prompt', 'consent')
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

  // Authenticated fetch helper. `path` is appended to XERO_API_BASE
  // unless it's a full URL (some endpoints — Files, Identity — sit
  // on different bases and we pass the absolute URL).
  //
  // Body handling:
  //   - object → JSON-stringified, Content-Type defaults to JSON
  //   - URLSearchParams / Buffer / FormData → passed through as-is
  //
  // Response handling:
  //   - opts.responseType === 'buffer' → returns raw Uint8Array
  //     (used by PDF download from /Invoices/{id} with Accept:
  //     application/pdf)
  //   - default → JSON-parsed response body, or text if not JSON
  const xfetch = async (path, opts = {}) => {
    const url = path.startsWith('http') ? path : `${XERO_API_BASE}${path}`
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Xero-Tenant-Id': conn.tenant_id,
      Accept: 'application/json',
      ...(opts.headers || {}),
    }
    let body = opts.body
    const isPassthroughBody = body && (
      body instanceof URLSearchParams
      || body instanceof Buffer
      || body instanceof Uint8Array
      || (typeof FormData !== 'undefined' && body instanceof FormData)
    )
    if (body && typeof body === 'object' && !isPassthroughBody) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json'
      body = JSON.stringify(body)
    }
    const res = await fetch(url, { ...opts, headers, body })
    if (opts.responseType === 'buffer') {
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new XeroError(`Xero ${res.status} on ${path}`, { status: res.status, body: text })
      }
      const ab = await res.arrayBuffer()
      return new Uint8Array(ab)
    }
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
    if (!res.ok) {
      const base = json?.Detail || json?.Message || json?.detail || `Xero ${res.status} on ${path}`
      const details = flattenXeroValidationErrors(json)
      const msg = details.length ? `${base}: ${details.join('; ')}` : base
      throw new XeroError(msg, { status: res.status, body: json || text })
    }
    return json
  }

  return { conn, xfetch }
}
