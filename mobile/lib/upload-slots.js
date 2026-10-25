// MOBILE-UPLOAD.1 — the shared direct-to-storage upload flow.
//
// WHY THIS EXISTS. A multipart `{ uri, name, type }` FormData part has not
// reached the server from the phone since the Expo SDK 54→57 upgrade
// (26 Jul 2026): the fetch rejects on the device, so there is no request,
// no status code and nothing in the server logs. Three features shipped on
// that transport — issue photos, equipment-inspection fault photos and FTE
// expense receipts — and all three silently stopped uploading. The bytes
// now go device → Supabase Storage against a signed slot, the same route
// contractor invoices and company-card receipts already take.
//
// Two rules here are load-bearing, both learned from the "Send report"
// button that span forever (REPORT-ISSUE.3):
//   1. NOTHING in this module throws. Every failure is an envelope,
//      because a screen can only clear its spinner if the promise settles.
//   2. Every network step is time-boxed. A stalled upload with no timeout
//      is the same permanent spinner wearing a different hat.

import { authHeaders, API_BASE } from './api'
import { supabase } from './supabase'
import { readFileAsArrayBuffer } from './upload-bytes'

export const STEP_TIMEOUT_MS = 45_000

/**
 * Frees the UI when a step stalls. It does NOT cancel the in-flight
 * request: a finalise that lands after we have given up leaves the user
 * with an error and a saved row, which is why callers tell them to check
 * before resending. A duplicate report is cheap; a button that never comes
 * back is not.
 */
export function withTimeout(promise, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), STEP_TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Build a filename-extension → MIME resolver. Phone pickers do report a
 * mimeType, but an iPhone can hand back a stale .HEIC name on a re-encoded
 * JPEG, so the asset's own type is trusted first and this is the fallback.
 */
export function mimeResolver(extMap, fallback) {
  return (name, declared) => {
    if (declared) return String(declared).toLowerCase()
    const m = String(name || '').match(/\.([A-Za-z0-9]+)$/)
    return (m && extMap[m[1].toLowerCase()]) || fallback
  }
}

/**
 * The image types every photo surface takes — an issue report and an
 * equipment-inspection fault alike. Mirrors ALLOWED_PHOTO_MIME on the
 * server (mobile cannot import server modules).
 */
export const resolvePhotoMime = mimeResolver({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
}, 'image/jpeg')

/**
 * Read picked assets ({ uri, name, mimeType } from expo-image-picker or
 * expo-document-picker) into ArrayBuffers of their real bytes.
 *
 * It must be an ArrayBuffer: a Blob from fetch(uri) uploads a ZERO-BYTE
 * object on React Native (see lib/upload-bytes.js for the full story).
 *
 * @returns {Promise<{ok: true, files: object[]} | {ok: false, error: string}>}
 */
export async function readPickedFiles(picked = [], { resolveMime, label = 'file' } = {}) {
  const files = []
  for (let i = 0; i < picked.length; i++) {
    const p = picked[i]
    const name = p?.name || `${label}-${i + 1}.jpg`
    const mime = resolveMime ? resolveMime(name, p?.mimeType) : String(p?.mimeType || '').toLowerCase()
    let bytes
    try {
      bytes = await readFileAsArrayBuffer(p?.uri)
    } catch (err) {
      return { ok: false, error: `Could not read ${label} ${i + 1}: ${err?.message || err}` }
    }
    if (!bytes || bytes.byteLength === 0) {
      return { ok: false, error: `${label} ${i + 1} appears to be empty — attach it again.` }
    }
    files.push({ name, mime, bytes })
  }
  return { ok: true, files }
}

/**
 * Mint one signed slot per file at `signUrl`, then push the bytes straight
 * to `bucket`. Returns the descriptors a finalise route accepts.
 *
 * The server mints the paths, so a client cannot choose where its bytes
 * land — every finalise route re-checks that the path is a slot it issued
 * and reads the size/mime back off Storage.
 *
 * @returns {Promise<{ok: true, uploaded: object[]} | {ok: false, error: string}>}
 */
export async function uploadToSlots({ signUrl, bucket, files = [], locationId }) {
  if (files.length === 0) return { ok: true, uploaded: [] }

  const signHeaders = await authHeaders({ locationId, json: true })
  const signRes = await withTimeout(fetch(`${API_BASE}${signUrl}`, {
    method: 'POST',
    headers: signHeaders,
    body: JSON.stringify({
      files: files.map((f) => ({ file_name: f.name, size: f.bytes.byteLength, mime: f.mime })),
    }),
  }), 'Preparing the upload')
  const sign = await signRes.json().catch(() => ({
    success: false, error: `Bad response (${signRes.status})`,
  }))
  if (sign.success === false || !Array.isArray(sign.slots) || sign.slots.length !== files.length) {
    return { ok: false, error: sign.error || 'Could not start the upload.' }
  }

  const uploaded = []
  for (let i = 0; i < files.length; i++) {
    const { error: upErr } = await withTimeout(
      supabase.storage
        .from(bucket)
        .uploadToSignedUrl(sign.slots[i].path, sign.slots[i].token, files[i].bytes, { contentType: files[i].mime }),
      `Uploading ${i + 1}`
    )
    if (upErr) return { ok: false, error: `Upload ${i + 1} failed: ${upErr.message}` }
    uploaded.push({
      path: sign.slots[i].path,
      file_name: files[i].name,
      size: files[i].bytes.byteLength,
      mime: files[i].mime,
    })
  }
  return { ok: true, uploaded }
}
