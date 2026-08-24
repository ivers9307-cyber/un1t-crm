// ANDROID-VIS.1 — a stable per-INSTALL identity for this device, used as
// the conflict key when registering with /api/mobile/device-tokens.
//
// WHY IT EXISTS. device_tokens used to be keyed by the Expo push token, so
// a device only got a row once it had one. On Android that needs FCM
// credentials this project has never had, so the token call throws, the
// failure is swallowed (by design — reporting must never break the surface
// that triggered it) and the device is invisible to BOTH push and the
// staff-device / geofence-permission report. The key below separates the
// two: identity is something the app can always produce, a push token is a
// capability the device may or may not have.
//
// NO NEW NATIVE DEPENDENCY, deliberately. expo-application's androidId /
// identifierForVendor would be the textbook answer but adding it is a
// native change — new binary + a store round-trip before a single Android
// device appears. An app-generated id in SecureStore (expo-secure-store is
// already a dependency and already carries the studio pairing) needs
// nothing new, so this ships over OTA.
//
// SEMANTICS. Per install, not per handset: a reinstall mints a new key and
// therefore a new row, and the old row ages out on the 90-day
// sweep-stale-push-tokens cron. That is the same lifetime the Expo token
// had, so the report gains no new class of ghost row.

import * as SecureStore from 'expo-secure-store'

const STORAGE_KEY = 'device_installation_key'

/** Must agree with the `device_key` regex on the server route. */
export const DEVICE_KEY_PATTERN = /^[a-f0-9]{32}$/

export function isValidDeviceKey(value) {
  return typeof value === 'string' && DEVICE_KEY_PATTERN.test(value)
}

/**
 * Mint a new key: 32 lowercase hex chars.
 *
 * Math.random is not cryptographic and does not need to be — this is an
 * opaque row key, never a credential (the request is already authenticated
 * by the Supabase JWT, and the server pins every row to `user_id`; knowing
 * someone's device_key grants nothing). It carries ~80 bits of randomness
 * on top of a millisecond timestamp, against a fleet of tens of devices.
 *
 * `random`/`now` are injectable so the collision-shape can be tested.
 */
export function generateDeviceKey(random = Math.random, now = Date.now) {
  const stamp = Math.floor(now()).toString(16).padStart(12, '0').slice(-12)
  let out = stamp
  while (out.length < 32) {
    out += Math.floor(random() * 0x100000000).toString(16).padStart(8, '0')
  }
  return out.slice(0, 32)
}

/**
 * ANDROID-VIS.1b — the in-flight resolution, memoized at module scope.
 *
 * getDeviceKey() is a read-then-mint, and TWO call sites fire it
 * fire-and-forget on the same cold start: (staff)/(tabs)/_layout.jsx via
 * registerForPushNotifications(), and LocationGate via reportDeviceState().
 * Both would read "nothing stored", both would mint, and the device would
 * end up with TWO rows — one of them an orphan under a key no client holds
 * any more, which nothing can ever update and only the 90-day sweep
 * removes. Memoizing the PROMISE (not the value) closes the window: the
 * second caller awaits the first caller's resolution instead of starting
 * its own.
 *
 * Never reset. A device key is meant to outlive everything in the process,
 * and resolveDeviceKey() cannot reject — the failure paths all return a
 * usable key — so there is no failed state worth retrying.
 */
let inFlight = null

/**
 * Read this install's key, minting and persisting one on first call.
 *
 * A key we could generate but not persist is still returned: the report
 * lands under a one-off key rather than not landing at all, which is the
 * better failure (an extra row beats an invisible device). Within a single
 * process the memo above keeps even that key stable.
 */
export async function getDeviceKey() {
  inFlight ??= resolveDeviceKey()
  return inFlight
}

async function resolveDeviceKey() {
  try {
    const existing = await SecureStore.getItemAsync(STORAGE_KEY)
    if (isValidDeviceKey(existing)) return existing
  } catch {
    // Unreadable keychain — fall through and try to mint a fresh one.
  }

  const minted = generateDeviceKey()
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, minted)
  } catch {
    // Not persisted; still usable for this run. See the doc above.
  }
  return minted
}

/**
 * Best-effort read that never mints. Used on sign-out, where creating an
 * identity for a device we are about to deregister would be backwards.
 */
export async function peekDeviceKey() {
  try {
    const existing = await SecureStore.getItemAsync(STORAGE_KEY)
    return isValidDeviceKey(existing) ? existing : null
  } catch {
    return null
  }
}
