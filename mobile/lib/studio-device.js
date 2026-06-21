// mobile/lib/studio-device.js
// Studio-device pairing + per-user menu cache, persisted in
// expo-secure-store (iOS Keychain). Two concerns, one small module:
//
//   1. Pairing — the device token + label that turn this iPad into a
//      shared studio kiosk. Presence of a token === "paired".
//   2. Menu cache — each returning staffer's {profile, locations,
//      activeLocation} blob, keyed by user id, so their options paint
//      instantly on tap-in (stale-while-revalidate). NEVER tokens,
//      NEVER customer data.
//
// All cache writes are best-effort: SecureStore has a ~2 KB per-value
// limit, so an unusually large menu blob (a master with many locations)
// may fail to persist — that just means no cache speed-up for that user,
// never a crash. The auth path must never throw because of the cache.

import * as SecureStore from 'expo-secure-store'

const PAIRING_KEY = 'studio_device_pairing'
const MENU_CACHE_PREFIX = 'studio_menu_cache.'
const MENU_INDEX_KEY = 'studio_menu_cache_index' // CSV of cached user ids

// --- Pairing -------------------------------------------------------------

export async function getPairing() {
  try {
    const raw = await SecureStore.getItemAsync(PAIRING_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export async function savePairing({ token, label }) {
  if (!token || token.length < 16) throw new Error('savePairing: token too short')
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify({ token, label: label || '' }))
}

export async function clearPairing() {
  await SecureStore.deleteItemAsync(PAIRING_KEY)
  await clearAllMenuCache()
}

// --- Menu cache ----------------------------------------------------------

export async function readMenuCache(userId) {
  if (!userId) return null
  try {
    const raw = await SecureStore.getItemAsync(`${MENU_CACHE_PREFIX}${userId}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export async function writeMenuCache(userId, data) {
  if (!userId || !data) return
  try {
    await SecureStore.setItemAsync(`${MENU_CACHE_PREFIX}${userId}`, JSON.stringify(data))
    await addToIndex(userId)
  } catch {
    // best-effort — never throw into the auth path (e.g. >2 KB blob).
  }
}

export async function clearAllMenuCache() {
  try {
    const idx = await SecureStore.getItemAsync(MENU_INDEX_KEY)
    const ids = idx ? idx.split(',').filter(Boolean) : []
    for (const id of ids) await SecureStore.deleteItemAsync(`${MENU_CACHE_PREFIX}${id}`)
    await SecureStore.deleteItemAsync(MENU_INDEX_KEY)
  } catch {
    // best-effort
  }
}

async function addToIndex(userId) {
  const idx = await SecureStore.getItemAsync(MENU_INDEX_KEY)
  const ids = new Set(idx ? idx.split(',').filter(Boolean) : [])
  ids.add(userId)
  await SecureStore.setItemAsync(MENU_INDEX_KEY, Array.from(ids).join(','))
}
