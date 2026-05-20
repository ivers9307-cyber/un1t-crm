// FTE-EXPENSES.2 (mobile) — wraps the /api/expenses routes.
//
// Mirrors mobile/lib/invoices-api.js but for the header+items
// expense model. The header (claim) and items (receipts) are two
// distinct CRUD surfaces, so the wrapper exposes both. Receipt
// uploads go via multipart FormData using the RN { uri, name, type }
// file shape — exactly the same pattern as submitInvoice().

import Constants from 'expo-constants'
import { supabase } from './supabase'

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl

async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { Accept: 'application/json' }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  return headers
}

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
 * Add a line item to a draft claim. The receipt arg is { uri, name,
 * mimeType } from expo-image-picker (camera roll / camera) or
 * expo-document-picker (PDF). Pass null if no receipt this iteration.
 */
export async function addExpenseItem({
  claimId, expenseDate, category, amount, vatAmount, vendor, description, receipt,
}) {
  const headers = await authHeaders()
  const fd = new FormData()
  fd.append('expense_date', expenseDate)
  fd.append('category', category)
  fd.append('amount', String(amount))
  fd.append('vat_amount', String(vatAmount || 0))
  if (vendor) fd.append('vendor', vendor)
  if (description) fd.append('description', description)
  if (receipt) {
    fd.append('receipt', {
      uri: receipt.uri,
      name: receipt.name || 'receipt.jpg',
      type: receipt.mimeType || 'image/jpeg',
    })
  }
  // NB: do NOT set Content-Type — RN's fetch sets the multipart
  // boundary automatically. Setting it explicitly breaks the request.
  const res = await fetch(`${API_BASE}/api/expenses/${claimId}/items`, {
    method: 'POST',
    headers,
    body: fd,
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
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
