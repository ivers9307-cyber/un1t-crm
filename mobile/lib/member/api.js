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
// TODO(stage C): the 401 paths below sign out via the shared client
// (scope: 'local'), which in the merged app ends the STAFF session too.
// Unreachable until the resolver lands (nothing routes into the member
// tree); stage C revisits sign-out semantics for the one-session model.

import Constants from 'expo-constants'
import { supabase } from './supabase'
import { isAcceptableSuccessBody } from './response-envelope'

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

  // 401 handling: refresh once, retry once, then sign out.
  if (response.status === 401 && !_isRetry) {
    const { error: refreshError } = await supabase.auth.refreshSession()
    if (!refreshError) {
      // Retry once with fresh headers (pass _isRetry=true to prevent recursion).
      return request(base, path, options, true)
    }
    // Refresh itself failed — sign the user out and surface a friendly message.
    // scope: 'local' — the default ('global') revokes every refresh token the user holds (all devices).
    await supabase.auth.signOut({ scope: 'local' })
    return { success: false, error: 'Your session expired. Please sign in again.' }
  }
  if (response.status === 401 && _isRetry) {
    // scope: 'local' — the default ('global') revokes every refresh token the user holds (all devices).
    await supabase.auth.signOut({ scope: 'local' })
    return { success: false, error: 'Your session expired. Please sign in again.' }
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
