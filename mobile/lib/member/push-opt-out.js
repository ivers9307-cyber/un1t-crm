import * as SecureStore from 'expo-secure-store'

// Persists the member's push opt-out choice so it survives app restarts.
// Mirrors profile-setup-dismissal.js. When set, the launch-time push
// registration in app/(tabs)/_layout.jsx must NOT re-register the device —
// otherwise a member who turns push OFF is silently re-subscribed next launch
// (OS permission is still granted, so registration would otherwise succeed).
const KEY = 'push_opt_out'

export async function isPushOptedOut() {
  try {
    return (await SecureStore.getItemAsync(KEY)) === '1'
  } catch { return false }
}

export async function setPushOptOut(optedOut) {
  try {
    if (optedOut) await SecureStore.setItemAsync(KEY, '1')
    else await SecureStore.deleteItemAsync(KEY)
  } catch { /* best-effort */ }
}
