// Mobile impersonation state — small persisted blob in SecureStore so
// every api() call can pick up the active target without going through
// React state. The auth-context surfaces the same value so UI can render
// the banner / picker, but api() reads directly from SecureStore to
// avoid a synchronisation hazard during cold start (api may be called
// before the AuthProvider has hydrated).
//
// Shape: { targetId, startedAt }   stored as JSON
//   - targetId: UUID of the user being impersonated
//   - startedAt: ISO timestamp; used to auto-stop after 24h to mirror
//     the web cookie's max-age.

import * as SecureStore from 'expo-secure-store'

const KEY = 'un1t_impersonate_v1'
export const MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Read the persisted impersonation state. Returns null when nothing
 * is stored or when the stored row is past MAX_AGE_MS (auto-stop).
 *
 * Note: this does NOT call the server stop endpoint when expiring —
 * we let the next /api/mobile/me round-trip naturally drop the
 * impersonation header, and a master can manually stop later. The
 * impersonation_log row stays open until manually stopped, which
 * matches the web's cookie behaviour (cookie expires, log stays open
 * until the next start/stop closes it).
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
