// Mobile-side contractor invoices API. Wraps the same /api/invoices
// routes the web Invoices manager uses. Headers — Bearer auth,
// x-active-location, and the x-impersonate-target "View as user"
// header — are built by the shared authHeaders() helper so they can't
// drift; do NOT hand-roll them here (dropping x-impersonate-target is
// what made View-as show the master's whole-location invoice queue).
//
// PDF upload — submitInvoice() builds a multipart FormData with the
// PDF picked via expo-document-picker. The Next.js POST route
// already handles multipart bodies.

import Constants from 'expo-constants'
import { authHeaders } from './api'
import { supabase } from './supabase'

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl

/**
 * GET /api/invoices — role-aware list. The mobile app today only
 * shows the contractor's own submissions, but the server returns
 * the appropriate set automatically.
 */
export async function listInvoices() {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/invoices`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function getInvoice(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/invoices/${id}`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function getInvoicePdfUrl(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/invoices/${id}/pdf`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function revokeInvoice(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/invoices/${id}/revoke`, {
    method: 'POST',
    headers,
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

// APPROVALS — owner/master approve or decline a submitted contractor invoice.
// Decline requires a reason (the route 400s without it).
export async function approveInvoice(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/invoices/${id}/approve`, { method: 'POST', headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function declineInvoice(id, reason) {
  const headers = await authHeaders({ json: true })
  const res = await fetch(`${API_BASE}/api/invoices/${id}/decline`, {
    method: 'POST', headers, body: JSON.stringify({ reason }),
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * Submit a new invoice. file = { uri, name, mimeType, size? } from
 * expo-document-picker.
 *
 * INVOICE-UPLOAD.1 — three-step direct-to-storage flow. The old version
 * POSTed the PDF as multipart through /api/invoices, but Vercel caps
 * serverless request bodies at ~4.5 MB, so the advertised 10 MB limit
 * 413'd for bigger files (same bug class as the WA template video fix).
 * Now the bytes go straight from the device to Supabase Storage:
 *   1. /api/invoices/upload-sign mints a path + signed-upload token.
 *   2. The PDF uploads directly to the private contractor-invoices
 *      bucket (uploadToSignedUrl — the token is the authz).
 *   3. /api/invoices (JSON mode) verifies the object and inserts.
 * The server keeps multipart back-compat, so older app builds still
 * work while this rolls out via OTA.
 */
export async function submitInvoice({
  monthKey, amount, invoiceNumber, notes, locationId, file,
}) {
  const fileName = file.name || 'invoice.pdf'

  // Read the picked document into a Blob. RN's fetch handles file://
  // (and expo-document-picker cache) URIs; the blob carries the real
  // byte size for the sign-time validation.
  let blob
  try {
    blob = await (await fetch(file.uri)).blob()
  } catch (err) {
    return { success: false, error: `Could not read the selected file: ${err.message || err}` }
  }

  // 1. Mint the signed direct-to-storage upload slot (tiny JSON).
  const signHeaders = await authHeaders({ locationId, json: true })
  const signRes = await fetch(`${API_BASE}/api/invoices/upload-sign`, {
    method: 'POST',
    headers: signHeaders,
    body: JSON.stringify({
      month: monthKey,
      size: blob.size,
      mime: 'application/pdf',
      file_name: fileName,
    }),
  })
  const sign = await signRes.json().catch(() => ({ success: false, error: `Bad response (${signRes.status})` }))
  if (sign.success === false || !sign.token) {
    return { success: false, error: sign.error || 'Could not start the upload.' }
  }

  // 2. Device → Supabase Storage directly (bypasses the API size cap).
  const { error: upErr } = await supabase.storage
    .from('contractor-invoices')
    .uploadToSignedUrl(sign.path, sign.token, blob, { contentType: 'application/pdf' })
  if (upErr) {
    return { success: false, error: `Upload failed: ${upErr.message}` }
  }

  // 3. Finalise — the server verifies the stored PDF and inserts the row.
  const headers = await authHeaders({ locationId, json: true })
  const res = await fetch(`${API_BASE}/api/invoices`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      month: monthKey,
      amount: Number(amount),
      invoice_number: invoiceNumber || null,
      notes: notes || null,
      location_id: locationId || null,
      pdf_path: sign.path,
      pdf_name: fileName,
    }),
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

// ── Period helpers — mirrors src/lib/contractor-invoices.js ──────

export function periodForMonth(monthKey) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
    throw new Error(`Invalid month key "${monthKey}", expected YYYY-MM.`)
  }
  const [y, m] = monthKey.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1))
  const end = new Date(Date.UTC(y, m, 0))
  return {
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
    label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  }
}

export function recentMonthOptions(now = new Date(), count = 12) {
  const out = []
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1))
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    out.push({ key, ...periodForMonth(key) })
  }
  return out
}

export function defaultMonthKey(now = new Date()) {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
}

export function periodLabel(periodStart) {
  if (!periodStart) return ''
  const d = new Date(periodStart + 'T00:00:00Z')
  return d.toLocaleDateString(undefined, {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  })
}
