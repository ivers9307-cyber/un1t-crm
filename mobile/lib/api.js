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

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl

if (!API_BASE) {
  // eslint-disable-next-line no-console
  console.error('[api] Missing EXPO_PUBLIC_API_BASE_URL.')
}

/**
 * @param {string} path                e.g. '/api/mobile/me'
 * @param {object} [options]
 * @param {string} [options.method]    'GET' | 'POST' | 'PUT' | 'DELETE'
 * @param {object} [options.body]      JSON-serialisable
 * @param {string} [options.locationId] override the active location for this call
 * @returns {Promise<{success: boolean, data?: any, error?: string, issues?: any[]}>}
 */
export async function api(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  if (options.locationId) headers['x-active-location'] = options.locationId

  let response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
  } catch (err) {
    return { success: false, error: `Network error: ${err.message || err}` }
  }

  // The CRM responds with the standard { success, data?, error?, issues? }
  // shape; surface it as-is so callers can branch on .success.
  let json
  try {
    json = await response.json()
  } catch {
    return {
      success: false,
      error: `Non-JSON response (${response.status})`,
    }
  }

  if (!response.ok && json?.success !== false) {
    // Server returned non-2xx without our standard envelope.
    return { success: false, error: json?.error || `HTTP ${response.status}` }
  }
  return json
}
