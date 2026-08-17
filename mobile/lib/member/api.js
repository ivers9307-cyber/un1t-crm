// PHASE2 (one-app merge, stage B) — the member tree's fetch helpers, ported
// from champ-app/mobile/lib/api.js with champ's lib/crm-api.js folded in.
// The staff app's own mobile/lib/api.js is untouched — member screens import
// THIS module (lib/member/api).
//
// Two bases:
//   - api()    → extra.champApiBaseUrl — the member-app (champ) Next.js
//                deployment, which still hosts the member-facing /api/*
//                routes (social, push registration, review-login, …).
//   - crmApi() → extra.apiBaseUrl — this app's own CRM deployment. Champ
//                read a separate extra.crmApiBaseUrl for these routes
//                (customer-authed Apple Health ingest/connect etc.); in the
//                merged app the CRM base IS the app's apiBaseUrl.
//
// Both ride the SHARED Supabase client (lib/supabase via the member shim),
// so the Authorization header carries the one session the merged app holds.
//
// STAGE C sign-out policy (one-session model — locked decision): the app
// holds ONE session for both shells, so this helper self-signs-out ONLY on
// an explicit invalid-refresh-token error from the shared client's refresh
// attempt (the session is provably dead everywhere). A HOST-level failure —
// 401 with a freshly-refreshed token, 5xx, network error, timeout — must
// degrade the member surface only: we return the usual { success:false }
// error envelope the ported member screens already render as error states,
// and NEVER end the staff session. When it does sign out, it routes through
// performFullSignOut() (lib/sign-out.js) — the same teardown the kiosk
// idle-lock path calls, so on a paired studio device the session drop lands
// in StudioPinProvider's lock/pad flow rather than a bare auth flip.

import Constants from 'expo-constants'
import { supabase } from './supabase'
import { isAcceptableSuccessBody } from './response-envelope'

// Typed error for callers that prefer throwing semantics over the
// { success:false } envelope (none of the ported champ screens do — they
// all branch on the envelope — but the identity spine and future member
// modules can wrap results in this).
export class MemberApiError extends Error {
  constructor(message, { status, hostLevel = false } = {}) {
    super(message)
    this.name = 'MemberApiError'
    this.status = status
    this.hostLevel = hostLevel
  }
}

// Only supabase-auth "this refresh token is dead" failures qualify —
// transport/host failures (Failed to fetch, retryable 5xx) never do.
export function isInvalidRefreshTokenError(error) {
  if (!error) return false
  const code = typeof error.code === 'string' ? error.code : ''
  if (code === 'refresh_token_not_found' || code === 'refresh_token_already_used') return true
  const msg = String(error.message || '').toLowerCase()
  return msg.includes('invalid refresh token')
}

// Dynamic import so the static graph stays acyclic (sign-out.js imports the
// member push-register, which imports this module).
async function selfSignOut() {
  try {
    const { performFullSignOut } = await import('../sign-out')
    await performFullSignOut()
  } catch {
    // Teardown must never leave a dead session half-alive — fall back to
    // the bare local sign-out champ used.
    try { await supabase.auth.signOut({ scope: 'local' }) } catch { /* best-effort */ }
  }
}

const API_BASE = Constants.expoConfig?.extra?.champApiBaseUrl
const CRM_BASE = Constants.expoConfig?.extra?.apiBaseUrl

export async function authHeaders({ json = false } = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { Accept: 'application/json' }
  if (json) headers['Content-Type'] = 'application/json'
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  return headers
}

// Internal: execute a single fetch attempt with a 15 s AbortController timeout.
// Returns { response } on success or { fetchError } on network/abort failure.
async function fetchWithTimeout(url, fetchOptions) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)
  let response
  try {
    response = await fetch(url, { ...fetchOptions, signal: controller.signal })
  } catch (err) {
    return { fetchError: err.name === 'AbortError' ? 'Request timed out — check your connection.' : 'Network error. Please try again.' }
  } finally {
    clearTimeout(timeoutId)
  }
  return { response }
}

// Shared request core for both bases — identical semantics to champ's api()
// and crmApi() (which were copy-paste twins): 401 → refresh once, retry once,
// then sign out; JSON-envelope guard on 200s.
async function request(base, path, options = {}, _isRetry = false) {
  const headers = await authHeaders({ json: true })
  const fetchOptions = {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  }

  const { response, fetchError } = await fetchWithTimeout(`${base}${path}`, fetchOptions)
  if (fetchError) return { success: false, error: fetchError }

  // 401 handling: refresh once, retry once. Sign-out ONLY on a provably
  // dead refresh token — see the module header for the one-session policy.
  if (response.status === 401 && !_isRetry) {
    const { error: refreshError } = await supabase.auth.refreshSession()
    if (!refreshError) {
      // Retry once with fresh headers (pass _isRetry=true to prevent recursion).
      return request(base, path, options, true)
    }
    if (isInvalidRefreshTokenError(refreshError)) {
      // The session is dead everywhere — full teardown (staff + member).
      await selfSignOut()
      return { success: false, error: 'Your session expired. Please sign in again.' }
    }
    // Refresh failed for a transient reason (auth outage, offline) —
    // degrade this surface only; the staff session stays untouched.
    return { success: false, error: 'Could not verify your session. Please try again.' }
  }
  if (response.status === 401 && _isRetry) {
    // Host-level 401 on a FRESHLY-refreshed token: the champ host is
    // rejecting a token Supabase just minted (outage / authz gap). NEVER
    // a sign-out — the shared session is demonstrably alive.
    return { success: false, error: 'Could not load this right now. Please try again.' }
  }

  let json
  try { json = await response.json() } catch { return { success: false, error: `Non-JSON response (${response.status})` } }

  // Guard malformed HTTP-200: reject a 200 whose body carries no recognised
  // envelope key (success/ok/data). Shared predicate (see response-envelope.js).
  if (response.ok && !isAcceptableSuccessBody(json)) {
    return { success: false, error: 'Unexpected response from the server.' }
  }

  if (!response.ok && json?.success !== false) return { success: false, error: json?.error || `HTTP ${response.status}` }
  return json
}

export function api(path, options = {}) {
  return request(API_BASE, path, options)
}

export function crmApi(path, options = {}) {
  return request(CRM_BASE, path, options)
}
