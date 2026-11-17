// PHONEHOME.1 — the studio a staff member picked on the phone, remembered.
//
// The phone's active studio is only an x-active-location header on
// /api/mobile/me (auth-context refresh). Nothing kept the pick, so every cold
// start and every token refresh asked /me with no header and the server's
// default studio came back, with no notice. This keeps the last pick per
// signed-in user, so refresh() can ask for it again.
//
// Keyed by user id: a shared device signed in by someone else never inherits
// the previous person's studio. Best-effort: a storage failure only means the
// server default, as before.

import AsyncStorage from '@react-native-async-storage/async-storage'

const keyFor = (userId) => `un1t.active_location.v1.${userId}`

export async function readActiveLocationId(userId) {
  if (!userId) return null
  try {
    const v = await AsyncStorage.getItem(keyFor(userId))
    return typeof v === 'string' && v.length > 0 ? v : null
  } catch {
    return null
  }
}

export async function writeActiveLocationId(userId, locationId) {
  if (!userId) return
  try {
    if (locationId) await AsyncStorage.setItem(keyFor(userId), String(locationId))
    else await AsyncStorage.removeItem(keyFor(userId))
  } catch { /* best-effort */ }
}

/**
 * Pure: what to do with the remembered studio after a /me answer. A pick the
 * server did not honour (a studio the person no longer holds; the server
 * ignores such a header and falls back) is forgotten, so it is not asked for
 * again. While impersonating nothing changes: the list is the other person's.
 * A NEW pick is written by setActiveLocationId, never here, so the server's
 * default is never remembered as if it had been chosen.
 * @returns {'keep'|'clear'}
 */
export function rememberAfterMe({ asked = null, answered = null, impersonating = false } = {}) {
  if (impersonating) return 'keep'
  if (asked && answered !== asked) return 'clear'
  return 'keep'
}
