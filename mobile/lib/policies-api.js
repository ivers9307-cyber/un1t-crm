// Mobile-side policies API. Mirrors contracts-api.js. POLICIES-VIEWS.1
// replaced the acknowledgement flow with passive view tracking.
//
// Reads (listPolicies) are open to any authenticated user (RLS).
// View sessions are own-row only via Bearer JWT. The web API
// classifies acknowledged_via from the user-agent — Expo's default
// UA matches the mobile branch, so no extra header is needed.

import Constants from 'expo-constants'
import { supabase } from './supabase'

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl

async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  return headers
}

/** GET /api/policies — current versions + caller's view status. */
export async function listPolicies() {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/policies`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * POST /api/policies/[slug]/views — start a view session. Returns
 * { success, view: { id, started_at } } on success. Caller passes
 * the returned id to endPolicyView() at session end.
 */
export async function startPolicyView(slug) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/policies/${encodeURIComponent(slug)}/views`, {
    method: 'POST',
    headers,
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * PATCH /api/policies/[slug]/views — end / progress a view session.
 * The server takes max(prev, new) on duration so multiple PATCHes
 * (focus blur, AppState background, unmount) all converge on the
 * longest dwell observed.
 */
export async function endPolicyView(slug, { viewId, totalDurationSeconds, sectionDwell }) {
  if (!viewId) return { success: false, error: 'view_id is required' }
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/policies/${encodeURIComponent(slug)}/views`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      view_id: viewId,
      total_duration_seconds: Math.max(0, Math.floor(totalDurationSeconds || 0)),
      section_dwell: sectionDwell || null,
    }),
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * Convenience: how many active policies does this user have whose
 * current version they have NOT opened. Drives the badge on the
 * More-tab row. Returns -1 on network error so the UI can hide the
 * badge rather than show a misleading number.
 */
export async function getOutstandingPolicyCount() {
  try {
    const json = await listPolicies()
    if (!json?.success) return -1
    const list = json.data || []
    return list.filter((p) => p.current_version && !p.viewed_at).length
  } catch {
    return -1
  }
}
