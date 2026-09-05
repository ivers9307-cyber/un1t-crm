// Thin wrapper for calling the Next.js /api/* routes from the mobile
// app. Adds the Authorization: Bearer <jwt> header and (when set) the
// x-active-location header that the web cookie-based switcher would
// otherwise provide.
//
// Most CRUD goes direct to Supabase via the supabase client (RLS handles
// scoping). Use api() only for routes that need orchestration (Postmark
// send, WhatsApp send, UniFi toggle, push register, assistant chat).

import Constants from 'expo-constants'
import { supabase } from './supabase'
import { readImpersonate } from './impersonate'
import { buildAuthHeaders } from './api-headers'

// REPSET-P6.S2 — exported so every hand-rolled client wrapper (checklists,
// inbox approvals, issues, maintenance) builds on the SAME base as api(),
// resolved once through app.config.js extra.apiBaseUrl (EXPO_PUBLIC_
// override first, canonical repset default second). One flip point.
export const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl

if (!API_BASE) {
  // eslint-disable-next-line no-console
  console.error('[api] Missing EXPO_PUBLIC_API_BASE_URL.')
}

/**
 * Resolve the standard auth headers for a call to /api/* — Bearer
 * token, optional active-location override, and (critically) the
 * x-impersonate-target header so "View as user" reaches the server.
 *
 * Every hand-rolled client wrapper (invoices, expenses, contracts,
 * checklists, issues, policies) MUST build its headers through this
 * helper rather than inlining `Authorization: Bearer …` — that's how
 * the impersonation header gets dropped and View-as silently runs as
 * the real master. Multipart callers pass no `json` so RN can set the
 * FormData boundary itself.
 *
 * @param {object} [opts]
 * @param {string} [opts.locationId] x-active-location override for this call
 * @param {boolean} [opts.json]      include Content-Type: application/json
 * @returns {Promise<Record<string,string>>}
 */
// MOBILE-SESSION.1 — getSession() is a NETWORK call whenever the access
// token has aged out (Supabase refreshes on read, hourly by default), so on a
// marginal mobile link it can fail — and a refresh whose body arrives
// truncated throws a JSON parse SyntaxError out of the Supabase client, not a
// tidy error result. One retry costs a few hundred ms and clears the common
// case: a single dropped packet during a 5G handover. A second failure
// rethrows, and api() below turns it into a transport envelope.
const SESSION_RETRY_MS = 400

async function getSessionWithRetry() {
  try {
    return await supabase.auth.getSession()
  } catch {
    await new Promise((resolve) => setTimeout(resolve, SESSION_RETRY_MS))
    return supabase.auth.getSession()
  }
}

export async function authHeaders({ locationId, json = false } = {}) {
  const { data: { session } } = await getSessionWithRetry()

  // Master impersonation (mig 035). Best-effort — never fail a call
  // because the local impersonate blob couldn't be read. readImpersonate
  // also auto-expires the target past the session max-age.
  let impersonateTargetId = null
  try {
    const imp = await readImpersonate()
    impersonateTargetId = imp?.targetId || null
  } catch {
    // leave impersonateTargetId null
  }

  return buildAuthHeaders({
    token: session?.access_token,
    impersonateTargetId,
    locationId,
    json,
  })
}

/**
 * @param {string} path                e.g. '/api/mobile/me'
 * @param {object} [options]
 * @param {string} [options.method]    'GET' | 'POST' | 'PUT' | 'DELETE'
 * @param {object} [options.body]      JSON-serialisable
 * @param {string} [options.locationId] override the active location for this call
 * @returns {Promise<{success: boolean, data?: any, error?: string, issues?: any[], transport?: true, status?: number}>}
 *   `transport: true` (api()-minted, no server answer)
 */
export async function api(path, options = {}) {
  // MOBILE-SESSION.1 — INSIDE the guard, not above it. authHeaders() awaits a
  // token refresh that can throw on a bad link, and this call used to sit
  // outside every try in the file: the throw escaped api() itself, so screens
  // rendered whatever the Supabase client raised — an operator at Hatch Street
  // pressing a plug off on 5G was shown a raw "JSON Parse error". A session we
  // could not read is the same fact as a dropped fetch (no server answer, the
  // request was never sent), so it answers with the same transport envelope
  // and pollers keep their last good state through it.
  let headers
  try {
    headers = await authHeaders({ locationId: options.locationId, json: true })
  } catch {
    return {
      success: false,
      transport: true,
      error: 'Network error: could not refresh your session — check your connection and try again',
    }
  }

  let response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
  } catch (err) {
    // transport: true marks an envelope api() minted itself without a server
    // answer (dropped fetch, non-JSON body). Consumers that poll use it to
    // keep their last good state through a blip rather than painting the
    // failure — see SonosControlCard. Additive; every other caller reads
    // only success/error.
    return { success: false, transport: true, error: `Network error: ${err.message || err}` }
  }

  // The CRM responds with the standard { success, data?, error?, issues? }
  // shape; surface it as-is so callers can branch on .success.
  let json
  try {
    json = await response.json()
  } catch {
    // `status` rides along so a consumer can tell an edge 5xx error page
    // (retry) from an HTML 404 off a wrong base URL (don't) without
    // parsing the message — geofence.js's retry queue is the reader.
    return {
      success: false,
      transport: true,
      status: response.status,
      error: `Non-JSON response (${response.status})`,
    }
  }

  if (!response.ok && typeof json?.success !== 'boolean') {
    // Server returned non-2xx without our standard envelope (an edge error
    // page, a platform 504). Synthesise one, carrying `status` for the same
    // reason the non-JSON branch above does: a caller that needs to tell one
    // non-2xx from another must read a FIELD, not match this error string.
    return { success: false, status: response.status, error: json?.error || `HTTP ${response.status}` }
  }
  // SHELLY-MOB.1 — a non-2xx that DOES carry our envelope passes through
  // UNCHANGED. The condition above used to be `success !== false`, which
  // swallowed a body that explicitly said `success: true` — the one live
  // case being POST /api/shelly/devices/<id>/toggle answering HTTP **429**
  // with `success: true, pending: true`: the override IS saved and the cron
  // will apply it; the 429 is a back-off signal so the client stops
  // re-pressing, not a failure. Replacing that body rendered "HTTP 429" and
  // told an operator their switch failed when it did not. Passing it through
  // hands mobile/lib/shelly.js's isQueued/toggleResultText the real
  // `pending`, `message` and `code` fields instead of a status-code
  // inference — and existing callers see exactly what they always saw,
  // because every pre-existing non-2xx either carries `success: false`
  // (unchanged path) or no boolean `success` at all (still synthesised).
  //
  // MAIL-403.1 — one ADDITIVE key on that unchanged path: a non-2xx envelope
  // that says `success: false` also carries `status`, the way the synthesised
  // and non-JSON branches above already do. Without it a caller could tell a
  // 403 from a 500 only when the body was NOT ours — the contact composer's
  // account list answers a 403 WITH our envelope, so "no Mail access at this
  // studio" could never be told from "the list failed". The body's own
  // fields win: a route that already sends `status` keeps it. A `success:
  // true` non-2xx (the Shelly 429) is untouched, as is every 2xx.
  if (!response.ok && json.success === false && json.status === undefined) {
    return { ...json, status: response.status }
  }
  return json
}
