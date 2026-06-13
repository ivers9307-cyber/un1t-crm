// SPEND.P3 (mobile) — company-card receipts API. Wraps the same
// /api/card-receipts routes the web Card Receipts surface uses. Headers
// — Bearer auth, x-active-location, and the x-impersonate-target "View
// as user" header — are built by the shared authHeaders() helper so they
// can't drift; do NOT hand-roll them here (dropping x-impersonate-target
// is what made View-as show the master's whole-location queue, the
// documented #382 bug class).
//
// One receipt per company-card purchase (STANDALONE — not batched like
// FTE expenses). A card holder photographs / uploads the receipt; the
// bytes go DIRECT to Supabase Storage (the same three-step flow as the
// contractor invoice / SPEND.P1 receipt path), then a JSON finalise
// inserts the row. Owner/master approve; it then rides the existing
// bookkeeper → Xero queue.

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
 * GET /api/card-receipts — role-aware list. Owner/master get the
 * active-location queue; everyone else gets their own submissions. The
 * server returns the appropriate set automatically; the optional status
 * filter narrows it (submitted | awaiting_accountant_review | declined |
 * revoked).
 */
export async function listCardReceipts(status) {
  const headers = await authHeaders()
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  const res = await fetch(`${API_BASE}/api/card-receipts${qs}`, { headers })
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

// APPROVALS — owner/master approve or decline a submitted card receipt.
// Decline requires a reason (the route 400s without it).
export async function approveCardReceipt(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/card-receipts/${id}/approve`, { method: 'POST', headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function declineCardReceipt(id, reason) {
  const headers = await authHeaders({ json: true })
  const res = await fetch(`${API_BASE}/api/card-receipts/${id}/decline`, {
    method: 'POST', headers, body: JSON.stringify({ reason }),
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

// REVOKE — submitter pulls back their own submitted receipt.
export async function revokeCardReceipt(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/card-receipts/${id}/revoke`, {
    method: 'POST',
    headers,
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * Submit a new company-card receipt. file = { uri, name, mimeType, size? }
 * from expo-document-picker (PDF) or expo-image-picker (receipt photo).
 *
 * Three-step direct-to-storage flow — identical to submitInvoice(). The
 * bytes go straight from the device to the private company-card-receipts
 * bucket (Vercel caps serverless request bodies at ~4.5 MB, so a multipart
 * POST of the advertised 10 MB limit would 413):
 *   1. /api/card-receipts/upload-sign mints a path + signed-upload token.
 *   2. The file uploads directly to Supabase Storage (uploadToSignedUrl —
 *      the token is the authz).
 *   3. /api/card-receipts (JSON finalise) verifies the object and inserts.
 */
export async function submitCardReceipt({
  purchaseDate, amount, vatAmount, merchant, description, cardLast4,
  notes, locationId, file,
}) {
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

  // 3. Finalise — the server verifies the stored object and inserts the row.
  const headers = await authHeaders({ locationId, json: true })
  const res = await fetch(`${API_BASE}/api/card-receipts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      purchase_date: purchaseDate,
      amount: Number(amount),
      vat_amount: vatAmount != null && vatAmount !== '' ? Number(vatAmount) : undefined,
      merchant: merchant || undefined,
      description: description || undefined,
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

export function formatPurchaseDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T00:00:00Z')
  return d.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  })
}
