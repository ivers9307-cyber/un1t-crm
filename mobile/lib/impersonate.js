// Mobile impersonation state — small persisted blob in SecureStore so
// every api() call can pick up the active target without going through
// React state. The auth-context surfaces the same value so UI can render
// the banner / picker, but api() reads directly from SecureStore to
// avoid a synchronisation hazard during cold start (api may be called
// before the AuthProvider has hydrated).
//
// Shape: { targetId, startedAt }   stored as JSON
//   - targetId: UUID of the user being impersonated
//   - startedAt: ISO timestamp; used to auto-stop after the session
//     max-age to mirror the web cookie's max-age.
//
// Keep MAX_AGE_MS in sync with IMPERSONATE_SESSION_MAX_AGE_SECONDS in
// src/lib/impersonation.js (currently 2h) — there's no shared import
// across the web/native boundary, and the close-stale-impersonations
// reaper closes the audit row at that same age.

import * as SecureStore from 'expo-secure-store'

const KEY = 'un1t_impersonate_v1'
export const MAX_AGE_MS = 2 * 60 * 60 * 1000

/**
 * Read the persisted impersonation state. Returns null when nothing
 * is stored or when the stored row is past MAX_AGE_MS (auto-stop).
 *
 * Note: this does NOT call the server stop endpoint when expiring —
 * we let the next /api/mobile/me round-trip naturally drop the
 * impersonation header. The open impersonation_log row is then closed
 * by the hourly close-stale-impersonations reaper (it stamps ended_at
 * at the session max-age), so an expired-without-Stop session no longer
 * dangles open forever in the audit trail.
 */
export async function readImpersonate() {
  try {
    const raw = await SecureStore.getItemAsync(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.targetId || !parsed?.startedAt) return null
    const age = Date.now() - new Date(parsed.startedAt).getTime()
    if (age >= MAX_AGE_MS) {
      await SecureStore.deleteItemAsync(KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export async function writeImpersonate({ targetId }) {
  const value = JSON.stringify({
    targetId,
    startedAt: new Date().toISOString(),
  })
  await SecureStore.setItemAsync(KEY, value)
}

export async function clearImpersonate() {
  try {
    await SecureStore.deleteItemAsync(KEY)
  } catch {
    // Best-effort.
  }
}
