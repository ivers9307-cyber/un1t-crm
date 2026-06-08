// Hand-rolled Google OAuth 2.0 + Business Profile client. Mirrors the Xero
// client (src/lib/xero/client.js): withFreshToken() refreshes + persists the
// rotated token, then hands callers a Bearer-authenticated fetch helper.
//
// Reviews live on the LEGACY v4 endpoint (mybusiness.googleapis.com/v4); the
// newer split APIs (Account Management, Business Information) host accounts +
// locations. All three are reachable with the business.manage scope.

import { createServerClient } from '@/lib/supabase'

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GBP_SCOPE        = 'https://www.googleapis.com/auth/business.manage'
const REFRESH_BUFFER_MS = 60 * 1000

export class GoogleBusinessError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message)
    this.name = 'GoogleBusinessError'
    this.status = status
    this.body = body
    if (cause) this.cause = cause
  }
}

function envOrThrow(name) {
  const v = process.env[name]
  if (!v) throw new GoogleBusinessError(`Missing required env var: ${name}`)
  return v
}

export function getGoogleClientCreds() {
  return {
    clientId: envOrThrow('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: envOrThrow('GOOGLE_OAUTH_CLIENT_SECRET'),
    redirectUri: envOrThrow('GOOGLE_OAUTH_REDIRECT_URI'),
  }
}

export function buildAuthorizeUrl({ state }) {
  const { clientId, redirectUri } = getGoogleClientCreds()
  const u = new URL(GOOGLE_AUTH_URL)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('scope', GBP_SCOPE)
  u.searchParams.set('state', state)
  u.searchParams.set('access_type', 'offline') // issue a refresh_token
  u.searchParams.set('prompt', 'consent')      // force refresh_token re-issue on reconnect
  return u.toString()
}

async function tokenRequest(params) {
  const { clientId, clientSecret } = getGoogleClientCreds()
  const body = new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret })
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new GoogleBusinessError(`Google token request failed: ${res.status}`, { status: res.status, body: json })
  }
  return json
}

export function exchangeAuthorizationCode(code) {
  const { redirectUri } = getGoogleClientCreds()
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
}

export function refreshAccessToken(refreshToken) {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
}

async function apiGet(accessToken, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new GoogleBusinessError(`Google API ${res.status} on ${url}`, { status: res.status, body: json })
  }
  return json
}

// Account Management API — the accounts this token can manage.
export async function listAccounts(accessToken) {
  const json = await apiGet(accessToken, 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts')
  return Array.isArray(json.accounts) ? json.accounts : []
}

// Business Information API — locations under an account. accountResource is
// e.g. "accounts/123". Returns [{ name: 'locations/456', title }].
export async function listLocations(accessToken, accountResource) {
  const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${accountResource}/locations?readMask=name,title&pageSize=100`
  const json = await apiGet(accessToken, url)
  return Array.isArray(json.locations) ? json.locations : []
}

// Legacy v4 reviews. locationResource is the FULL path
// "accounts/123/locations/456". Returns { reviews, averageRating,
// totalReviewCount, nextPageToken }.
export async function listReviews(accessToken, locationResource, pageToken) {
  let url = `https://mybusiness.googleapis.com/v4/${locationResource}/reviews?pageSize=50`
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`
  return apiGet(accessToken, url)
}

// Load the stored connection, refresh if near expiry, persist the rotated
// token. Returns { conn, accessToken }. Service-role so cron/background safe.
export async function withFreshToken(locationId) {
  const db = createServerClient()
  const { data: conn, error } = await db
    .from('google_business_connections')
    .select('*')
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) throw new GoogleBusinessError(`Failed to load Google connection: ${error.message}`)
  if (!conn) throw new GoogleBusinessError('No Google Business connection for this location.')

  const expiresAt = new Date(conn.expires_at).getTime()
  const needsRefresh = Number.isFinite(expiresAt) && expiresAt - Date.now() < REFRESH_BUFFER_MS

  let accessToken = conn.access_token
  if (needsRefresh) {
    const refreshed = await refreshAccessToken(conn.refresh_token)
    accessToken = refreshed.access_token
    // Google only re-issues refresh_token on first consent / prompt=consent;
    // keep the existing one when the refresh response omits it.
    const newRefresh = refreshed.refresh_token || conn.refresh_token
    const newExpiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString()
    const { error: upErr } = await db
      .from('google_business_connections')
      .update({ access_token: accessToken, refresh_token: newRefresh, expires_at: newExpiresAt })
      .eq('id', conn.id)
    if (upErr) throw new GoogleBusinessError(`Failed to persist refreshed token: ${upErr.message}`)
  }

  return { conn, accessToken }
}
