// FTE-EXPENSES.2 (mobile) — wraps the /api/expenses routes.
//
// Mirrors mobile/lib/invoices-api.js but for the header+items
// expense model. The header (claim) and items (receipts) are two
// distinct CRUD surfaces, so the wrapper exposes both. Receipt
// uploads go via multipart FormData using the RN { uri, name, type }
// file shape — exactly the same pattern as submitInvoice().

import Constants from 'expo-constants'
import { authHeaders } from './api'
import { mimeResolver, readPickedFiles, uploadToSlots, withTimeout } from './upload-slots'

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl

export const RECEIPT_BUCKET = 'fte-expense-receipts'

// A receipt is a PDF or a phone-camera image. Mirrors
// RECEIPT_ACCEPTED_MIMES on the server (mobile cannot import server
// modules); the picker's own mimeType is trusted first.
const resolveReceiptMime = mimeResolver({
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
}, 'image/jpeg')

// ────────────────────────────────────────────────────────────────
// Claim CRUD
// ────────────────────────────────────────────────────────────────

export async function listExpenseClaims(statusFilter) {
  const headers = await authHeaders()
  const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ''
  const res = await fetch(`${API_BASE}/api/expenses${qs}`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function getExpenseClaim(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/expenses/${id}`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function createExpenseClaim({ monthKey, locationId, notes }) {
  const headers = { ...(await authHeaders()), 'Content-Type': 'application/json' }
  const res = await fetch(`${API_BASE}/api/expenses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      month: monthKey,
      location_id: locationId,
      notes: notes || null,
    }),
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function deleteExpenseClaim(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/expenses/${id}`, {
    method: 'DELETE',
    headers,
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function submitExpenseClaim(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/expenses/${id}/submit`, {
    method: 'POST',
    headers,
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function revokeExpenseClaim(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/expenses/${id}/revoke`, {
    method: 'POST',
    headers,
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function approveExpenseClaim(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/expenses/${id}/approve`, {
    method: 'POST',
    headers,
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function declineExpenseClaim(id, reason) {
  const headers = { ...(await authHeaders()), 'Content-Type': 'application/json' }
  const res = await fetch(`${API_BASE}/api/expenses/${id}/decline`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason }),
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

// ────────────────────────────────────────────────────────────────
// Item CRUD
// ────────────────────────────────────────────────────────────────

/**
 * Add a line item to a draft claim. `receipt` is { uri, name, mimeType }
 * from expo-image-picker (camera roll / camera) or expo-document-picker
 * (PDF). Pass null if no receipt this iteration.
 *
 * MOBILE-UPLOAD.1 — the receipt goes device → Storage against a signed
 * slot (lib/upload-slots.js) and this call sends its PATH as JSON, so the
 * server inserts the row complete in one write. It used to ride as a
 * multipart part, which has not left the device since the Expo SDK 57
 * upgrade — nothing has landed in the receipts bucket since 15 Jul — and
 * could not have carried a 10 MB receipt past Vercel's ~4.5 MB body cap
 * anyway. Answers an envelope for every failure; it must never throw, or
 * the screen keeps its spinner (REPORT-ISSUE.3).
 */
export async function addExpenseItem({
  claimId, expenseDate, category, amount, vatAmount, vendor, description, receipt,
}) {
  try {
    const read = await readPickedFiles(receipt ? [receipt] : [], {
      resolveMime: resolveReceiptMime,
      label: 'receipt',
    })
    if (!read.ok) return { success: false, error: read.error }

    const up = await uploadToSlots({
      signUrl: `/api/expenses/${claimId}/upload-sign`,
      bucket: RECEIPT_BUCKET,
      files: read.files,
    })
    if (!up.ok) return { success: false, error: up.error }

    const headers = await authHeaders({ json: true })
    const res = await withTimeout(fetch(`${API_BASE}/api/expenses/${claimId}/items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        expense_date: expenseDate,
        category,
        amount: Number(amount),
        vat_amount: Number(vatAmount || 0),
        vendor: vendor || null,
        description: description || null,
        receipt: up.uploaded[0] || null,
      }),
    }), 'Adding the item')
    return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
  } catch (err) {
    return { success: false, error: `Network error: ${err?.message || err}` }
  }
}

export async function deleteExpenseItem(claimId, itemId) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/expenses/${claimId}/items/${itemId}`, {
    method: 'DELETE',
    headers,
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function getReceiptUrl(claimId, itemId) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/expenses/${claimId}/items/${itemId}/receipt`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

// INVOICES-QUEUE.1 PR 3 — extractReceiptFields removed. OCR now
// runs exclusively from the bookkeeper's Analyse action inside the
// /invoices queue. The submitter attaches the receipt and types
// fields manually; Claude Vision runs once, later, on the same
// receipt during accountant sign-off.

// ────────────────────────────────────────────────────────────────
// Helpers — kept in lockstep with src/lib/fte-expenses.js
// ────────────────────────────────────────────────────────────────

export const EXPENSE_CATEGORIES = ['travel', 'meals', 'supplies', 'mileage', 'training', 'other']
export const EXPENSE_CATEGORY_LABELS = {
  travel:   'Travel',
  meals:    'Meals & Entertainment',
  supplies: 'Supplies',
  mileage:  'Mileage',
  training: 'Training',
  other:    'Other',
}

export function periodLabel(periodStart) {
  if (!periodStart) return ''
  const d = new Date(periodStart + 'T00:00:00Z')
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export function defaultMonthKey(now = new Date()) {
  // FTE expenses are typically submitted for the CURRENT month as the
  // operator captures them, rather than the prior month like contractor
  // invoices. Default to the current month for that reason.
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

export function recentMonthOptions(now = new Date(), count = 6) {
  const out = []
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1))
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    out.push({ key, label })
  }
  return out
}
