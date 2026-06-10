// Mobile orders (revenue) read client. Wraps GET /api/orders — the
// operator revenue view across race signups + car deposits. Read-only on
// mobile; the refund + retry-chain drill-in stay on the web Orders page.
//
// Goes through api() so the Bearer + x-impersonate-target + x-active-location
// headers are built by the shared helper and can't drift. Pass the active
// location id so the server scopes to the studio the app currently shows.
import { api } from './api'

/**
 * GET /api/orders → { success, data, counts, page, limit, total }
 * @param {object} opts
 * @param {string} [opts.locationId] active studio (x-active-location)
 * @param {string} [opts.status]     one ALLOWED_STATUSES value (omit = all)
 * @param {string} [opts.source]     'race_registration' | 'car_deposit'
 * @param {string} [opts.q]          contact name/email substring
 * @param {number} [opts.page]
 * @param {number} [opts.limit]
 */
export async function listOrders({ locationId, status, source, q, page = 1, limit = 50 } = {}) {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (source) params.set('source_type', source)
  if (q) params.set('q', q)
  params.set('page', String(page))
  params.set('limit', String(limit))
  return api(`/api/orders?${params.toString()}`, { locationId })
}

// ── Pure presentation helpers ──────────────────────────────────────

export function formatMoney(amountCents, currency = 'EUR') {
  const n = (Number(amountCents) || 0) / 100
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR' }).format(n)
  } catch {
    return `€${n.toFixed(2)}`
  }
}

export function orderSourceLabel(source) {
  if (source === 'race_registration') return 'Race signup'
  if (source === 'car_deposit') return 'Car deposit'
  return 'Order'
}

export function orderDateLabel(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return ''
  }
}
