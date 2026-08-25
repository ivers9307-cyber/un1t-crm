// mobile/lib/inbox-approvals-api.js — INBOX-APPROVALS Wave 2.
// Thread-scoped agent approval requests + decisions. Decisions go
// through the same web PATCH as the web inbox (atomic pending-claim,
// 409 when a colleague got there first).
//
// NB: distinct from mobile/lib/approvals-api.js, which wraps the
// generic /api/approvals/pending hub (MOBILE_APPROVAL_KEYS) for the
// /approvals screen — that's a different surface, out of scope here.

// REPSET-P6.S2 — base comes from the shared extra.apiBaseUrl resolution in
// lib/api.js (EXPO_PUBLIC_API_BASE_URL override, canonical repset default).
import { authHeaders, API_BASE } from './api'
import { supabase } from './supabase'

/**
 * List agent approval requests for one WA/IG conversation (any status),
 * so the thread can merge them alongside messages.
 */
export async function listConversationApprovals(conversationId) {
  const headers = await authHeaders()
  let res
  try {
    res = await fetch(`${API_BASE}/api/agent/membership-requests?conversation_id=${encodeURIComponent(conversationId)}`, { headers })
  } catch {
    return { success: false, error: 'Network error' }
  }
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * Conversation ids (WA + IG — the fk is per-channel but ids are uuids,
 * one set covers both) with a PENDING agent request at this location,
 * so the Messages list can badge rows the same way the web queue does
 * (INBOX-EMAIL-M.1). Direct Supabase read: mig 363 grants staff-wide
 * authenticated SELECT on agent_membership_requests (that's also what
 * the web's RLS-bound realtime rides), and mig 363's partial index
 * covers exactly this status='pending' lookup. No profiles embed.
 *
 * The /api/whatsapp/conversations route annotates `pending_approval`
 * server-side, but mobile WhatsApp reads go direct to Supabase, so the
 * flag has to be re-derived here. IG rows arrive pre-annotated from
 * /api/instagram/conversations; email threads never have approvals.
 *
 * Failure degrades to an empty set — the list renders without approval
 * pills rather than erroring.
 */
export async function listPendingApprovalConversationIds(locationId) {
  let q = supabase.from('agent_membership_requests')
    .select('conversation_id')
    .eq('status', 'pending')
    .limit(500)
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q
  if (error) return new Set()
  return new Set((data || []).map(r => r.conversation_id).filter(Boolean))
}

/**
 * Decide a pending approval request. `status` is 'approved' | 'declined' | 'saved'.
 * 409 means another colleague already decided it — the caller should
 * show "Already decided" and refresh.
 */
export async function decideApproval(requestId, status, decisionNote = null) {
  const headers = await authHeaders({ json: true })
  let res
  try {
    res = await fetch(`${API_BASE}/api/agent/membership-requests/${requestId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status, decision_note: decisionNote }),
    })
  } catch {
    return { success: false, error: 'Network error' }
  }
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}
