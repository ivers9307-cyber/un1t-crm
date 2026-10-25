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
import { readPickedFiles, resolvePhotoMime, uploadToSlots, withTimeout } from './upload-slots'
// A fault photo IS an issue photo: the inspection raises an ordinary issues
// row, so bucket, cap and sign route are the ones issues-api owns.
import { ISSUE_PHOTO_BUCKET, MAX_ISSUE_PHOTOS } from './issues-api'

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
 * POST /api/equipment/inspections/{id}/submit.
 *
 * `results` is the full local results map (belt-and-braces alongside the
 * individual PATCH ticks). `photos` is an array of { uri, name, mimeType }
 * from expo-image-picker, max 3, only meaningful when a check failed.
 * `locationId` scopes the call — the route 404s an inspection that isn't
 * at the caller's active location, so a multi-studio inspector needs it.
 *
 * MOBILE-UPLOAD.1 — the photos go device → Storage against a signed slot
 * (lib/upload-slots.js) and this call sends their PATHS as JSON. It used
 * to post the bytes as multipart, which has not left the device since the
 * Expo SDK 57 upgrade: an inspection with a fault photo could not be
 * submitted at all. Answers an envelope for every failure — it must never
 * throw, or the screen keeps its spinner (REPORT-ISSUE.3).
 */
export async function submitInspection(inspectionId, {
  results, note = '', takeOutOfService = false, photos = [], locationId,
} = {}) {
  try {
    const picked = (Array.isArray(photos) ? photos : []).slice(0, MAX_ISSUE_PHOTOS)
    const read = await readPickedFiles(picked, { resolveMime: resolvePhotoMime, label: 'photo' })
    if (!read.ok) return { success: false, error: read.error }

    // Fault photos live in the issue-photos bucket — the inspection raises
    // an ordinary issue row — so they take the issues sign route.
    const up = await uploadToSlots({
      signUrl: '/api/issues/upload-sign',
      bucket: ISSUE_PHOTO_BUCKET,
      files: read.files,
      locationId,
    })
    if (!up.ok) return { success: false, error: up.error }

    const headers = await authHeaders({ locationId, json: true })
    const res = await withTimeout(fetch(`${API_BASE}/api/equipment/inspections/${inspectionId}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        results: results || {},
        note,
        takeOutOfService: Boolean(takeOutOfService),
        photos: up.uploaded,
      }),
    }), 'Submitting the inspection')
    return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
  } catch (err) {
    return { success: false, error: `Network error: ${err?.message || err}` }
  }
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
