// CHECKLIST.2 — mobile API client for the coach's checklist.
// GETs today's instance(s) and ticks individual items.

// REPSET-P6.S2 — base comes from the shared extra.apiBaseUrl resolution in
// lib/api.js (EXPO_PUBLIC_API_BASE_URL override, canonical repset default).
import { authHeaders, API_BASE } from './api'

/**
 * Resolve (and lazily create) today's checklist instance(s) for
 * the signed-in coach. Returns { instances: [] } — empty when the
 * coach isn't on shift today or has no matching template.
 */
export async function getTodayChecklists() {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/mobile/checklists/today`, {
    headers, cache: 'no-store',
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/**
 * Tick (or untick) a single item. Returns the updated instance.
 */
export async function tickChecklistItem({ instanceId, itemId, checked }) {
  const headers = await authHeaders()
  headers['Content-Type'] = 'application/json'
  const res = await fetch(
    `${API_BASE}/api/mobile/checklists/${instanceId}/items/${itemId}`,
    {
      method: checked ? 'POST' : 'DELETE',
      headers,
      body: checked ? JSON.stringify({ checked: true }) : undefined,
    }
  )
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

// ────────────────────────────────────────────────────────────────
// Display helpers
// ────────────────────────────────────────────────────────────────

export function progressFor(instance) {
  const total = (instance?.items || []).length
  const done = Object.keys(instance?.items_checked || {}).filter((k) => {
    // Only count keys that are still in the snapshot (defensive
    // against stale entries from a template edit).
    return (instance.items || []).some((i) => i.id === k)
  }).length
  return { done, total }
}

export function isComplete(instance) {
  return instance?.status === 'complete'
}

export function deadlineMinutesLeft(instance) {
  if (!instance?.deadline_at) return null
  const ms = new Date(instance.deadline_at).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / 60_000))
}
