// REPORT-ISSUE.1 — mobile API client for the issues feature.
// Mirrors the shape of mobile/lib/expenses-api.js so the styling
// patterns stay aligned.

// REPSET-P6.S2 — base comes from the shared extra.apiBaseUrl resolution in
// lib/api.js (EXPO_PUBLIC_API_BASE_URL override, canonical repset default).
import { authHeaders, API_BASE } from './api'
import { readPickedFiles, resolvePhotoMime, uploadToSlots, withTimeout } from './upload-slots'

export const ISSUE_PHOTO_BUCKET = 'issue-photos'
export const MAX_ISSUE_PHOTOS = 3

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
 * Submit a new issue. `photos` is an array of { uri, name, mimeType }
 * from expo-image-picker, up to 3. `locationId` is the studio the screen
 * named to the reporter ("the owners at X will be notified") — pass it, or
 * the server files the report wherever the profile's default lands.
 *
 * REPORT-ISSUE.3 — three-step direct-to-storage flow (lib/upload-slots.js):
 * sign a slot per photo, push the bytes device → Storage, then finalise
 * with the paths. It replaced a single multipart POST carrying the bytes
 * inline, which stopped leaving the device at Expo SDK 57 and — with
 * nothing here catching the rejection — left the screen's spinner running
 * forever. This function therefore NEVER throws: the screen can only clear
 * its spinner if the promise settles. The multipart route still exists
 * server-side for bundles that predate this.
 */
export async function submitIssue({ description, photos = [], locationId } = {}) {
  try {
    const picked = (Array.isArray(photos) ? photos : []).slice(0, MAX_ISSUE_PHOTOS)
    const read = await readPickedFiles(picked, { resolveMime: resolvePhotoMime, label: 'photo' })
    if (!read.ok) return { success: false, error: read.error }

    const up = await uploadToSlots({
      signUrl: '/api/issues/upload-sign',
      bucket: ISSUE_PHOTO_BUCKET,
      files: read.files,
      locationId,
    })
    if (!up.ok) return { success: false, error: up.error }

    const headers = await authHeaders({ locationId, json: true })
    const res = await withTimeout(fetch(`${API_BASE}/api/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ description, photos: up.uploaded }),
    }), 'Sending the report')
    return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
  } catch (err) {
    // The last line of defence. A throw from here is a spinner that never
    // stops, so there is no failure this may re-raise.
    return { success: false, error: `Network error: ${err?.message || err}` }
  }
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
