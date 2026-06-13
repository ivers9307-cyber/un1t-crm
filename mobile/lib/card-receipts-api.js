// SPEND.P3 (mobile) — company-card receipts API. Wraps the same
// /api/card-receipts routes the web Card Receipts surface uses. Headers
// — Bearer auth, x-active-location, and the x-impersonate-target "View
// as user" header — are built by the shared authHeaders() helper so they
// can't drift; do NOT hand-roll them here (dropping x-impersonate-target
// is what made View-as show the master's whole-location queue, the
// documented #382 bug class).
//
// One receipt per company-card purchase (STANDALONE — not batched like
// FTE expenses). The submitter ONLY provides the receipt photo/PDF (+ an
// optional "which card" last-4 + note) — they type NO financial fields.
// The bytes go DIRECT to Supabase Storage (the same three-step flow as
// the contractor invoice / SPEND.P1 receipt path), then a JSON finalise
// auto-files the row to the bookkeeper queue. The bookkeeper's OCR reads
// amount / merchant / date / VAT off the photo downstream in /invoices
// and files it to Xero. There is NO owner-approval step.

import Constants from 'expo-constants'
import { authHeaders } from './api'
import { supabase } from './supabase'

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl

// Filename-extension → MIME fallback for assets that don't report a
// type. Mirrors the accepted-mime set on the upload-sign route (mobile
// can't import server modules).
const RECEIPT_EXT_MIME = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
}
function inferReceiptMime(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]+)$/)
  return m ? (RECEIPT_EXT_MIME[m[1].toLowerCase()] || null) : null
}

/**
 * GET /api/card-receipts — the caller's OWN submissions only. Returns
 * rows shaped { id, status, card_last4, notes, submitted_at, location }.
 */
export async function listCardReceipts() {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/card-receipts`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function getCardReceipt(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/card-receipts/${id}`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function getCardReceiptUrl(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/card-receipts/${id}/receipt`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * Submit a new company-card receipt. file = { uri, name, mimeType, size? }
 * from expo-document-picker (PDF) or expo-image-picker (receipt photo).
 *
 * The submitter provides ONLY the photo (+ optional card last-4 + note) —
 * NO amount/merchant/date/VAT. Accounts read those off the photo in
 * /invoices downstream.
 *
 * Three-step direct-to-storage flow — identical to submitInvoice(). The
 * bytes go straight from the device to the private company-card-receipts
 * bucket (Vercel caps serverless request bodies at ~4.5 MB, so a multipart
 * POST of the advertised 10 MB limit would 413):
 *   1. /api/card-receipts/upload-sign mints a path + signed-upload token.
 *   2. The file uploads directly to Supabase Storage (uploadToSignedUrl —
 *      the token is the authz).
 *   3. /api/card-receipts (JSON finalise) verifies the object, inserts,
 *      and auto-files to the bookkeeper queue.
 */
export async function submitCardReceipt({ cardLast4, notes, locationId, file }) {
  const fileName = file.name || 'receipt.jpg'
  // Carry the real attachment type through to storage so the signed URL
  // later serves the right Content-Type and renders inline. Extension
  // fallback for assets that don't report a MIME (an iPhone may report a
  // stale .HEIC name on a re-encoded JPEG, so trust the asset MIME first).
  const mime = file.mimeType || inferReceiptMime(fileName) || 'image/jpeg'

  // Read the picked file into a Blob. RN's fetch handles file://
  // (and the picker cache) URIs; the blob carries the real byte size
  // for the sign-time validation.
  let blob
  try {
    blob = await (await fetch(file.uri)).blob()
  } catch (err) {
    return { success: false, error: `Could not read the selected file: ${err.message || err}` }
  }

  // 1. Mint the signed direct-to-storage upload slot (tiny JSON).
  const signHeaders = await authHeaders({ locationId, json: true })
  const signRes = await fetch(`${API_BASE}/api/card-receipts/upload-sign`, {
    method: 'POST',
    headers: signHeaders,
    body: JSON.stringify({
      size: blob.size,
      mime,
      file_name: fileName,
    }),
  })
  const sign = await signRes.json().catch(() => ({ success: false, error: `Bad response (${signRes.status})` }))
  if (sign.success === false || !sign.token) {
    return { success: false, error: sign.error || 'Could not start the upload.' }
  }

  // 2. Device → Supabase Storage directly (bypasses the API size cap).
  const { error: upErr } = await supabase.storage
    .from('company-card-receipts')
    .uploadToSignedUrl(sign.path, sign.token, blob, { contentType: mime })
  if (upErr) {
    return { success: false, error: `Upload failed: ${upErr.message}` }
  }

  // 3. Finalise — the server verifies the stored object, inserts the row,
  // and files it to the bookkeeper queue. Body is ONLY the photo path +
  // the two optional submitter fields.
  const headers = await authHeaders({ locationId, json: true })
  const res = await fetch(`${API_BASE}/api/card-receipts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      card_last4: cardLast4 || undefined,
      notes: notes || undefined,
      location_id: locationId || undefined,
      receipt_path: sign.path,
      receipt_name: fileName,
    }),
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

// ── Display helper ────────────────────────────────────────────────

// submitted_at is a full ISO timestamp (not the old YYYY-MM-DD
// purchase_date), so parse it as-is and show the local calendar day.
export function formatSubmittedAt(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}
