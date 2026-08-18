// EQUIP-MAINT.2 — mobile API client for the equipment inspection
// walk-round. Mirrors checklists-api.js's shape: thin fetch wrappers
// over authHeaders()/api() plus a few pure display helpers.
//
// The tick + submit routes reuse the shared auth-header builder so
// "View as user" (x-impersonate-target) keeps working — never
// hand-roll an Authorization header here.

// REPSET-P6.S2 — base comes from the shared extra.apiBaseUrl resolution in
// lib/api.js (EXPO_PUBLIC_API_BASE_URL override, canonical repset default).
import { authHeaders, API_BASE } from './api'

/**
 * GET /api/equipment/due — what's due for inspection at the active
 * studio, plus what's currently out of service. `enabled: false`
 * when inspections aren't set up (or switched off) for this location.
 */
export async function getDueEquipment() {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/equipment/due`, { headers, cache: 'no-store' })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * POST /api/equipment/{id}/inspection — create-or-resume the draft
 * for this asset's current cycle. Idempotent: a second call while a
 * draft is in progress returns the same draft.
 */
export async function openInspection(equipmentId) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/equipment/${equipmentId}/inspection`, {
    method: 'POST', headers,
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * PATCH /api/equipment/inspections/{id} — record one pass/fail mark.
 * `note` is required by the server when state is 'fail'.
 */
export async function tickInspectionItem(inspectionId, { itemId, state, note }) {
  const headers = await authHeaders({ json: true })
  const res = await fetch(`${API_BASE}/api/equipment/inspections/${inspectionId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ itemId, state, ...(state === 'fail' ? { note } : {}) }),
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * POST /api/equipment/inspections/{id}/submit — multipart submit.
 * `results` is the full local results map (belt-and-braces alongside
 * the individual PATCH ticks). `photos` is an array of
 * { uri, name, mimeType } from expo-image-picker, max 3, only
 * meaningful when a check failed.
 *
 * NB: do NOT set Content-Type — RN's fetch sets the multipart
 * boundary automatically. Setting it explicitly breaks the request
 * (same gotcha as issues-api.js's submitIssue).
 */
export async function submitInspection(inspectionId, {
  results, note = '', takeOutOfService = false, photos = [],
}) {
  const headers = await authHeaders()
  const fd = new FormData()
  fd.append('results', JSON.stringify(results || {}))
  fd.append('note', note)
  fd.append('takeOutOfService', String(Boolean(takeOutOfService)))
  photos.slice(0, 3).forEach((p, i) => {
    fd.append(`photo_${i}`, {
      uri: p.uri,
      name: p.name || `photo-${i + 1}.jpg`,
      type: p.mimeType || 'image/jpeg',
    })
  })
  const res = await fetch(`${API_BASE}/api/equipment/inspections/${inspectionId}/submit`, {
    method: 'POST',
    headers,
    body: fd,
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

// ────────────────────────────────────────────────────────────────
// Display helpers
// ────────────────────────────────────────────────────────────────

/** The snapshot's items, in checklist order. */
export function orderedItems(draft) {
  if (!draft?.items) return []
  return [...draft.items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/** Does every item in the snapshot carry a valid pass/fail mark? */
export function isFullyMarked(items, results) {
  if (!Array.isArray(items)) return false
  return items.every((it) => {
    const s = results?.[it.id]?.state
    return s === 'pass' || s === 'fail'
  })
}

/** Has at least one item been marked a fail? Gates the out-of-service toggle. */
export function hasAnyFail(results) {
  return Object.values(results || {}).some((r) => r?.state === 'fail')
}
