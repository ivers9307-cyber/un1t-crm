// Mobile-side contractor invoices API. Wraps the same /api/invoices
// routes the web Invoices manager uses. Auth + active-location
// header are handled by api(); we just shape the calls.
//
// PDF upload — submitInvoice() builds a multipart FormData with the
// PDF picked via expo-document-picker. The Next.js POST route
// already handles multipart bodies.

import Constants from 'expo-constants'
import { supabase } from './supabase'

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl

/**
 * GET /api/invoices — role-aware list. The mobile app today only
 * shows the contractor's own submissions, but the server returns
 * the appropriate set automatically.
 */
export async function listInvoices() {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { Accept: 'application/json' }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  const res = await fetch(`${API_BASE}/api/invoices`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function getInvoice(id) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { Accept: 'application/json' }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  const res = await fetch(`${API_BASE}/api/invoices/${id}`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function getInvoicePdfUrl(id) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { Accept: 'application/json' }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  const res = await fetch(`${API_BASE}/api/invoices/${id}/pdf`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function revokeInvoice(id) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { Accept: 'application/json' }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  const res = await fetch(`${API_BASE}/api/invoices/${id}/revoke`, {
    method: 'POST',
    headers,
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * Submit a new invoice. file = { uri, name, mimeType } from
 * expo-document-picker.
 */
export async function submitInvoice({
  monthKey, amount, invoiceNumber, notes, locationId, file,
}) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { Accept: 'application/json' }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  if (locationId) headers['x-active-location'] = locationId

  // React Native FormData — file must be a { uri, name, type } object.
  const fd = new FormData()
  fd.append('month', monthKey)
  fd.append('amount', String(amount))
  if (invoiceNumber) fd.append('invoice_number', invoiceNumber)
  if (notes) fd.append('notes', notes)
  if (locationId) fd.append('location_id', locationId)
  fd.append('pdf', {
    uri: file.uri,
    name: file.name || 'invoice.pdf',
    type: file.mimeType || 'application/pdf',
  })

  // NB: do NOT set 'Content-Type' manually — RN's fetch sets the
  // multipart boundary automatically when body is FormData. Setting
  // it explicitly here breaks the request.
  const res = await fetch(`${API_BASE}/api/invoices`, {
    method: 'POST',
    headers,
    body: fd,
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
