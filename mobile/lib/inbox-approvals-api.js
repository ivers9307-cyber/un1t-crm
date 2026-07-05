// mobile/lib/inbox-approvals-api.js — INBOX-APPROVALS Wave 2.
// Thread-scoped agent approval requests + decisions. Decisions go
// through the same web PATCH as the web inbox (atomic pending-claim,
// 409 when a colleague got there first).
//
// NB: distinct from mobile/lib/approvals-api.js, which wraps the
// generic /api/approvals/pending hub (MOBILE_APPROVAL_KEYS) for the
// /approvals screen — that's a different surface, out of scope here.

import { authHeaders } from './api'

const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  'https://crm.un1tdublin.com'

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
