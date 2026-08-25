// REPORT-ISSUE.1 — mobile API client for the issues feature.
// Mirrors the shape of mobile/lib/expenses-api.js so the styling
// patterns stay aligned.

// REPSET-P6.S2 — base comes from the shared extra.apiBaseUrl resolution in
// lib/api.js (EXPO_PUBLIC_API_BASE_URL override, canonical repset default).
import { authHeaders, API_BASE } from './api'

/**
 * List the signed-in user's own issue submissions (newest first).
 */
export async function listMyIssues() {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/issues`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * Drill into a single issue I submitted.
 */
export async function getMyIssue(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/issues/${id}`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * Submit a new issue. `photos` is an array of
 * { uri, name, mimeType } from expo-image-picker. Pass up to 3.
 */
export async function submitIssue({ description, photos = [] }) {
  const headers = await authHeaders()
  const fd = new FormData()
  fd.append('description', description)
  photos.slice(0, 3).forEach((p, i) => {
    fd.append(`photo_${i}`, {
      uri: p.uri,
      name: p.name || `photo-${i + 1}.jpg`,
      type: p.mimeType || 'image/jpeg',
    })
  })
  // NB: do NOT set Content-Type — RN's fetch sets the multipart
  // boundary automatically. Setting it explicitly breaks the request.
  const res = await fetch(`${API_BASE}/api/issues`, {
    method: 'POST',
    headers,
    body: fd,
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * Fetch a short-lived signed URL for a given attachment so the UI
 * can render the image. URLs expire after 10 min server-side.
 */
export async function getIssueAttachmentUrl(issueId, attachmentId) {
  const headers = await authHeaders()
  const res = await fetch(
    `${API_BASE}/api/issues/${issueId}/attachments/${attachmentId}`,
    { headers }
  )
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

// ────────────────────────────────────────────────────────────────
// Handler inbox (W1 — issue triage). Owner/master only; every route is
// gated by isHandler server-side and scoped to the active location.
// ────────────────────────────────────────────────────────────────

/**
 * List issues at the active studio for triage. `status` is a comma-
 * joined filter ('open,in_progress' is the server default for open work;
 * pass 'resolved' or 'closed' for the history tabs).
 */
export async function listInboxIssues({ status } = {}) {
  const headers = await authHeaders()
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  const res = await fetch(`${API_BASE}/api/issues/inbox${qs}`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/** Handler view of one issue (includes submitter + attachments). */
export async function getInboxIssue(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/issues/${id}/inbox`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/** Claim an open issue → in_progress, stamps claimed_by/at. */
export async function claimIssue(id) {
  const headers = await authHeaders({ json: true })
  const res = await fetch(`${API_BASE}/api/issues/${id}/claim`, { method: 'POST', headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/** Resolve an issue. `notes` is mandatory (the submitter gets pushed it). */
export async function resolveIssue(id, notes) {
  const headers = await authHeaders({ json: true })
  const res = await fetch(`${API_BASE}/api/issues/${id}/resolve`, {
    method: 'POST', headers, body: JSON.stringify({ notes }),
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/** Close an issue → closed (no submitter notification). */
export async function closeIssue(id) {
  const headers = await authHeaders({ json: true })
  const res = await fetch(`${API_BASE}/api/issues/${id}/close`, { method: 'POST', headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/** Signed URL for an attachment, via the handler-scoped route. */
export async function getInboxAttachmentUrl(issueId, attachmentId) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/issues/${issueId}/inbox/attachments/${attachmentId}`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

// ────────────────────────────────────────────────────────────────
// Display helpers
// ────────────────────────────────────────────────────────────────

export const ISSUE_STATUS_LABELS = Object.freeze({
  open:         'Open',
  in_progress:  'In progress',
  resolved:     'Resolved',
  closed:       'Closed',
})

export const ISSUE_STATUS_TONE = Object.freeze({
  open:         { bg: 'bg-amber-500/15',  fg: 'text-amber-200',  border: 'border-amber-500/30' },
  in_progress:  { bg: 'bg-blue-500/15',   fg: 'text-blue-200',   border: 'border-blue-500/30' },
  resolved:     { bg: 'bg-green-500/15',  fg: 'text-green-200',  border: 'border-green-500/30' },
  closed:       { bg: 'bg-un1t-border/40',  fg: 'text-un1t-subtle', border: 'border-un1t-border' },
})
