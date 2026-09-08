// REPORT-ISSUE.1 — mobile API client for the issues feature.
// Mirrors the shape of mobile/lib/expenses-api.js so the styling
// patterns stay aligned.

// REPSET-P6.S2 — base comes from the shared extra.apiBaseUrl resolution in
// lib/api.js (EXPO_PUBLIC_API_BASE_URL override, canonical repset default).
import { authHeaders, API_BASE } from './api'
import { supabase } from './supabase'
import { readFileAsArrayBuffer } from './upload-bytes'

export const ISSUE_PHOTO_BUCKET = 'issue-photos'
export const MAX_ISSUE_PHOTOS = 3

// Filename-extension → MIME fallback for assets that don't report a type.
// Mirrors ALLOWED_PHOTO_MIME on the server (mobile can't import server
// modules). Trust the picker's own mimeType first — an iPhone can hand back
// a stale .HEIC filename on a re-encoded JPEG.
const PHOTO_EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
}
function inferPhotoMime(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]+)$/)
  return m ? (PHOTO_EXT_MIME[m[1].toLowerCase()] || null) : null
}

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
 * REPORT-ISSUE.3 — three-step direct-to-storage flow, the same one the
 * contractor invoice and company-card receipt submits use:
 *   1. /api/issues/upload-sign mints a path + signed-upload token per photo.
 *   2. The bytes go device → Supabase Storage directly.
 *   3. POST /api/issues (JSON) verifies the objects and inserts the report.
 *
 * It replaced a single multipart POST that carried the photo bytes inline.
 * That stopped working on the phone: the request never left the device (the
 * production logs show this app's GETs and no POST at all), and because
 * NOTHING here caught the rejection, the screen's spinner ran forever. Two
 * rules came out of that and both are load-bearing:
 *   - this function NEVER throws. Every failure is an envelope, because the
 *     screen can only clear its spinner if the promise settles.
 *   - every network step is time-boxed. A stalled upload with no timeout is
 *     the same permanent spinner wearing a different hat.
 * The multipart route still exists server-side for bundles that predate
 * this, so an un-updated phone keeps working.
 */
const STEP_TIMEOUT_MS = 45_000

// Frees the UI when a step stalls. It does NOT cancel the in-flight request:
// a finalise that lands server-side after we've given up leaves the reporter
// with an error and a filed report, which is why the copy says to check
// "My reports" before resending. A duplicate problem report is cheap; a
// button that never comes back is not.
function withTimeout(promise, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), STEP_TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export async function submitIssue({ description, photos = [], locationId } = {}) {
  try {
    // 1. Read every photo off the device FIRST — no point minting upload
    //    slots for bytes we can't produce. A Blob from fetch(uri) does NOT
    //    transmit through uploadToSignedUrl on RN; it stores a zero-byte
    //    object (see lib/upload-bytes.js for the why), so this must be an
    //    ArrayBuffer.
    const picked = (Array.isArray(photos) ? photos : []).slice(0, MAX_ISSUE_PHOTOS)
    const files = []
    for (let i = 0; i < picked.length; i++) {
      const p = picked[i]
      const name = p?.name || `photo-${i + 1}.jpg`
      const mime = (p?.mimeType || inferPhotoMime(name) || 'image/jpeg').toLowerCase()
      let bytes
      try {
        bytes = await readFileAsArrayBuffer(p?.uri)
      } catch (err) {
        return { success: false, error: `Could not read photo ${i + 1}: ${err?.message || err}` }
      }
      if (!bytes || bytes.byteLength === 0) {
        return { success: false, error: `Photo ${i + 1} appears to be empty — attach it again.` }
      }
      files.push({ name, mime, bytes })
    }

    // 2. Mint one signed slot per photo (tiny JSON round-trip).
    let slots = []
    if (files.length > 0) {
      const signHeaders = await authHeaders({ locationId, json: true })
      const signRes = await withTimeout(fetch(`${API_BASE}/api/issues/upload-sign`, {
        method: 'POST',
        headers: signHeaders,
        body: JSON.stringify({
          photos: files.map((f) => ({ file_name: f.name, size: f.bytes.byteLength, mime: f.mime })),
        }),
      }), 'Preparing the photo upload')
      const sign = await signRes.json().catch(() => ({
        success: false, error: `Bad response (${signRes.status})`,
      }))
      if (sign.success === false || !Array.isArray(sign.slots) || sign.slots.length !== files.length) {
        return { success: false, error: sign.error || 'Could not start the photo upload.' }
      }
      slots = sign.slots

      // 3. Device → Storage directly. Bypasses the ~4.5 MB serverless
      //    request cap that made a 3-photo multipart submit impossible.
      for (let i = 0; i < files.length; i++) {
        const { error: upErr } = await withTimeout(
          supabase.storage
            .from(ISSUE_PHOTO_BUCKET)
            .uploadToSignedUrl(slots[i].path, slots[i].token, files[i].bytes, { contentType: files[i].mime }),
          `Uploading photo ${i + 1}`
        )
        if (upErr) {
          return { success: false, error: `Photo ${i + 1} upload failed: ${upErr.message}` }
        }
      }
    }

    // 4. Finalise — the server verifies each stored object and inserts.
    const headers = await authHeaders({ locationId, json: true })
    const res = await withTimeout(fetch(`${API_BASE}/api/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        description,
        photos: files.map((f, i) => ({
          path: slots[i].path,
          file_name: f.name,
          size: f.bytes.byteLength,
          mime: f.mime,
        })),
      }),
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
