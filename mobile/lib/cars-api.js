// Mobile cars read client (CCF Autos Tesla import tracker). Read-only on
// mobile — list + car detail. The heavy actions (deposit link, Xero
// invoice, document upload, status changes, delete) stay on the web Cars
// page.
//
// /api/cars + /api/cars/[id] are gated by car_processing + location scope
// server-side; go through the shared api() helper so Bearer +
// x-impersonate-target + x-active-location can't drift.
import { api } from './api'

/** GET /api/cars?status=&location_id= → { success, data: cars[] } */
export async function listCars({ locationId, status } = {}) {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (locationId) params.set('location_id', locationId)
  const qs = params.toString()
  return api(`/api/cars${qs ? `?${qs}` : ''}`, { locationId })
}

/** GET /api/cars/[id] → { success, data: car } (car_documents embedded) */
export async function getCar(id, { locationId } = {}) {
  return api(`/api/cars/${id}`, { locationId })
}

// ── Pure presentation helpers ──────────────────────────────────────

export function carTitle(car) {
  if (!car) return 'Car'
  const bits = [car.make, car.model, car.vehicle_year].filter(Boolean)
  return bits.length ? bits.join(' ') : (car.vin || 'Car')
}

export function carReg(car) {
  return car?.irish_reg || car?.uk_reg || car?.vin || '—'
}

// Whole-euro money — car prices are large; cents add noise.
export function carMoney(value) {
  const n = Number(value)
  if (value == null || !Number.isFinite(n)) return null
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)
  } catch {
    return `€${Math.round(n)}`
  }
}

export function carDateLabel(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return ''
  }
}

export const CAR_STATUS_STYLE = {
  new:       { label: 'New',       bg: 'bg-blue-500/20',  text: 'text-blue-700' },
  pending:   { label: 'Pending',   bg: 'bg-amber-500/20', text: 'text-amber-700' },
  completed: { label: 'Completed', bg: 'bg-green-500/20', text: 'text-green-700' },
}
