import * as SecureStore from 'expo-secure-store'
import { hkPermsVersionKey } from './apple-health-keys'

export async function getStoredPermsVersion(contactId) {
  if (!contactId) return null
  try {
    const v = await SecureStore.getItemAsync(hkPermsVersionKey(contactId))
    const n = v != null ? Number(v) : null
    return Number.isFinite(n) ? n : null
  } catch { return null }
}

export async function setStoredPermsVersion(contactId, version) {
  if (!contactId) return
  try { await SecureStore.setItemAsync(hkPermsVersionKey(contactId), String(version)) } catch { /* best-effort */ }
}
