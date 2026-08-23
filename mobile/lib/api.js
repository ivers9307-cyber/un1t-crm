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
export async function authHeaders({ locationId, json = false } = {}) {
  const { data: { session } } = await supabase.auth.getSession()

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
 * @returns {Promise<{success: boolean, data?: any, error?: string, issues?: any[], transport?: true}>}
 *   `transport: true` (api()-minted, no server answer)
 */
export async function api(path, options = {}) {
  const headers = await authHeaders({ locationId: options.locationId, json: true })

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
    return {
      success: false,
      transport: true,
      error: `Non-JSON response (${response.status})`,
    }
  }

  if (!response.ok && json?.success !== false) {
    // Server returned non-2xx without our standard envelope.
    return { success: false, error: json?.error || `HTTP ${response.status}` }
  }
  return json
}
