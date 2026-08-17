// PHASE2 stage C — last-used-side persistence for dual (staff+member)
// identities. A dual user's boot lands on whichever shell they last used;
// the switcher and the merged notification tap-router both write it.
// Cleared on sign-out (per-session preference, not device history).

import * as SecureStore from 'expo-secure-store'
import { STAFF_HOME, MEMBER_HOME } from './identity'

export const LAST_SIDE_KEY = 'repset_last_side'

const VALID_SIDES = new Set(['staff', 'member'])

/** @returns {Promise<'staff'|'member'|null>} */
export async function readLastSide() {
  try {
    const raw = await SecureStore.getItemAsync(LAST_SIDE_KEY)
    return VALID_SIDES.has(raw) ? raw : null
  } catch {
    return null
  }
}

export async function writeLastSide(side) {
  if (!VALID_SIDES.has(side)) return // never persist junk the resolver would honour
  try {
    await SecureStore.setItemAsync(LAST_SIDE_KEY, side)
  } catch { /* best-effort */ }
}

export async function clearLastSide() {
  try {
    await SecureStore.deleteItemAsync(LAST_SIDE_KEY)
  } catch { /* best-effort */ }
}

/** Shell home for a side; junk fails safe to the staff shell (today's default). */
export function routeForSide(side) {
  return side === 'member' ? MEMBER_HOME : STAFF_HOME
}
