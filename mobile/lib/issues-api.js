// REPORT-ISSUE.1 — mobile API client for the issues feature.
// Mirrors the shape of mobile/lib/expenses-api.js so the styling
// patterns stay aligned.

import { authHeaders } from './api'

const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  'https://crm.un1tdublin.com'

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
  closed:       { bg: 'bg-un1t-gray/40',  fg: 'text-un1t-light', border: 'border-un1t-gray' },
})
