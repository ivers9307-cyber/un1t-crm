// Register / unregister this device with the CRM.
//
// ANDROID-VIS.1 (mig 565) — the row is keyed by `device_key` (an
// app-generated per-install id, ./device-key.js), NOT by the Expo push
// token, which is now an optional capability of the row. A device that
// cannot obtain a token still registers and still reports. Read
// postDeviceState below before changing either entry point.
//
// Call registerForPushNotifications() after a successful login (with
// permissions.mobile.push_notifications enabled). Call
// unregisterPushNotifications() on signOut.
//
// On iOS, requesting permission shows the system "Allow Notifications?"
// modal the first time. If the user declines, we silently exit — they
// can re-enable later from iOS Settings → Repset → Notifications.
//
// In Expo Go (dev), the token is an Expo-channel token; in a custom
// build with Apple Developer credentials, it's an APNs-backed Expo
// token. Either way the format is ExponentPushToken[xxx].

import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import Constants from 'expo-constants'
import { Platform } from 'react-native'
import { api } from './api'
import { readImpersonate } from './impersonate'
import { getDeviceKey, peekDeviceKey } from './device-key'
import { ANDROID_CHANNELS } from 'shared/push-channels'

/**
 * ANDROID-VIS.1 — POST this device's state to the CRM.
 *
 * The ONE place either entry point writes a device row, so the two can
 * never drift on what a row contains. `token` may be null: since mig 565
 * the server keys the row on `device_key`, and a device with no push token
 * still reports its platform, app version, last-seen and geofence
 * permission. That is the whole fix — on Android `getExpoPushTokenAsync()`
 * throws for want of FCM credentials, and until now that swallowed failure
 * meant the device was never written at all, so it was invisible on
 * /settings/notifications/health as well as unreachable by push.
 *
 * Returns the server's response, or null if we had no identity to report
 * under at all (SecureStore unreadable AND unwritable AND no token).
 */
async function postDeviceState({ token, deviceKey, geofencePermission }) {
  if (!token && !deviceKey) return null
  return api('/api/mobile/device-tokens', {
    method: 'POST',
    body: {
      ...(token ? { expo_push_token: token } : {}),
      ...(deviceKey ? { device_key: deviceKey } : {}),
      platform: Platform.OS,
      device_name: Device.deviceName || undefined,
      app_version: Constants.expoConfig?.version,
      // Only sent when the caller actually knows it — see reportDeviceState.
      ...(geofencePermission ? { geofence_permission: geofencePermission } : {}),
    },
  })
}

// PHASE2 stage C — the foreground-presentation handler that used to live
// here (module scope) moved to the ROOT layout (app/_layout.jsx): the
// merged app registers ONE Notifications.setNotificationHandler that
// branches per payload type — staff types keep the sound+badge banner this
// module registered, member types keep champ's silent banner. See
// lib/notification-side.js presentationForNotification.

/**
 * Register this device's Expo push token with the CRM.
 *
 * @param {object} [opts]
 * @param {'always'|'when_in_use'|'denied'|'undetermined'} [opts.geofencePermission]
 *   The OS background-location verdict to report alongside the token
 *   (STAFF-DEV.7). Omitted when the caller doesn't know it — the server
 *   then leaves any stored value alone rather than nulling it.
 */
export async function registerForPushNotifications(opts = {}) {
  if (!Device.isDevice) {
    // Simulators don't get real push tokens. Skip silently.
    return { skipped: true, reason: 'simulator' }
  }

  // Paired studio kiosks never register for push. A kiosk's token would
  // be upserted under whichever staffer last PIN-unlocked, so their lead
  // alerts / WhatsApp notifications (customer PII) would land on the
  // shared gym device. Checked before the permission request so kiosks
  // never even show the iOS "Allow Notifications?" prompt.
  try {
    const { getPairing } = await import('./studio-device')
    if (await getPairing()) return { skipped: true, reason: 'studio_device' }
  } catch { /* SecureStore unreadable ⇒ treat as unpaired */ }

  // Check existing permission, request if not granted.
  const { status: existing } = await Notifications.getPermissionsAsync()
  let final = existing
  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync()
    final = status
  }
  if (final !== 'granted') {
    return { skipped: true, reason: 'permission_denied' }
  }

  // Android needs an explicit channel before tokens work. Create every
  // per-category channel (shared/push-channels.js — the same map the
  // server derives each message's channelId from). setNotificationChannelAsync
  // is idempotent per id, but note channels are IMMUTABLE once created on a
  // device: re-registering an existing id with a new spec is a no-op, and
  // importance can never be raised later — a re-spec needs a NEW channel id.
  if (Platform.OS === 'android') {
    for (const [id, spec] of Object.entries(ANDROID_CHANNELS)) {
      await Notifications.setNotificationChannelAsync(id, {
        name: spec.name,
        description: spec.description,
        importance:
          Notifications.AndroidImportance[spec.importance.toUpperCase()] ??
          Notifications.AndroidImportance.DEFAULT,
      })
    }
  }

  const deviceKey = await getDeviceKey()

  const projectId = Constants.expoConfig?.extra?.eas?.projectId
  let token
  let tokenReason
  try {
    const result = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    )
    token = result.data
  } catch (err) {
    tokenReason = `token_error: ${err.message || err}`
  }
  if (!token && !tokenReason) tokenReason = 'no_token'

  // ANDROID-VIS.1 — a failed token acquisition NO LONGER ABORTS THE
  // REPORT. It used to `return` here, which is precisely why Android has
  // zero rows in device_tokens: FCM credentials have never been configured
  // (mobile/docs/android-fcm-setup.md), so this call always throws there.
  // The device now registers with no token — visible in the fleet report,
  // simply not push-reachable — and picks up a token, in the SAME row, the
  // first time this call succeeds after FCM is set up.
  //
  // The return SHAPE is unchanged for the failure cases (`{ skipped,
  // reason }`), so no caller's behaviour changes; `reported` just tells a
  // caller that wants to know that the row landed anyway.
  const res = await postDeviceState({
    token,
    deviceKey,
    geofencePermission: opts.geofencePermission,
  })

  // `result` is carried on the skip too: LocationGate latches its
  // reportedRef on `res.result.success`, and without it a token-less
  // device would re-POST on every single foreground. isGenuinePushSuccess
  // (shared/push-registration.js) still reads this as NOT a success — it
  // requires `!skipped` AND a token — so the launch-time retry latch in
  // (staff)/(tabs)/_layout.jsx is unaffected.
  if (!token) return { skipped: true, reason: tokenReason, reported: res != null, result: res }

  return { token, result: res }
}

/**
 * STAFF-DEV.7 — report this device's current state (app version +
 * background-location permission) to the CRM WITHOUT going through the
 * push-permission flow.
 *
 * Why it exists: registerForPushNotifications() early-returns on a
 * simulator, a studio kiosk or a declined notification prompt, so a
 * staff member who said "no" to notifications never reported an
 * app_version at all — they showed up on the device-health page as if
 * they had no app. This path reuses the same upsert (conflict target =
 * device_key since mig 565) so it refreshes the existing row rather than
 * making a second one, and never prompts for anything.
 *
 * ANDROID-VIS.1 — it used to add "…and only reports when a token can
 * already be derived", which quietly excluded EVERY Android device and
 * every iOS user who had declined notifications: exactly the population
 * this function was written to rescue. The conflict target is `device_key`
 * now, so there is no longer anything to derive first.
 *
 * Every failure mode returns a `{ skipped, reason }` object rather than
 * throwing — callers fire this and forget it, and reporting must never
 * be able to break the surface that triggered it.
 *
 * @param {object} [opts]
 * @param {'always'|'when_in_use'|'denied'|'undetermined'} [opts.geofencePermission]
 * @returns {Promise<{token?: string, result?: object, skipped?: boolean, reason?: string}>}
 */
export async function reportDeviceState({ geofencePermission } = {}) {
  try {
    if (!Device.isDevice) return { skipped: true, reason: 'simulator' }

    // STAFF-DEV.10 — NEVER report mid-impersonation. api() attaches
    // x-impersonate-target straight from SecureStore, so getCurrentUser()
    // would resolve to the TARGET and this upsert (conflict target
    // device_key since mig 565) would RE-POINT the row's user_id — handing the
    // master's phone every subsequent push meant for the target
    // (WhatsApp threads, lead alerts: customer PII) and silently cutting
    // the master off from their own until they next sign in.
    //
    // The guard lives HERE, not only at the call site: a caller's React
    // state (`impersonatingFrom`) is populated by a fire-and-forget
    // /api/mobile/me refresh AFTER setSession, so on a cold start it is
    // still null while SecureStore already says "impersonating" — the
    // exact window LocationGate's foreground check runs in. SecureStore
    // is the authority, and this protects any future caller too. Same
    // reasoning (and the same read) as syncGeofences in ./geofence.
    try {
      const imp = await readImpersonate()
      if (imp?.targetId) return { skipped: true, reason: 'impersonating' }
    } catch { /* unreadable blob ⇒ treat as not impersonating */ }

    // Same kiosk carve-out as registration: a shared studio device must
    // never write a row under whichever staffer last PIN-unlocked it.
    try {
      const { getPairing } = await import('./studio-device')
      if (await getPairing()) return { skipped: true, reason: 'studio_device' }
    } catch { /* SecureStore unreadable ⇒ treat as unpaired */ }

    const deviceKey = await getDeviceKey()

    const projectId = Constants.expoConfig?.extra?.eas?.projectId
    let token
    let tokenReason
    try {
      const result = await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined
      )
      token = result?.data
    } catch (err) {
      // iOS refuses a token without notification permission; Android
      // refuses one without FCM credentials.
      tokenReason = `token_error: ${err?.message || err}`
    }
    if (!token && !tokenReason) tokenReason = 'no_token'

    // ANDROID-VIS.1 — THIS is the path the fleet report depends on
    // (LocationGate calls it on foreground), and until mig 565 it bailed
    // here whenever a token could not be derived: the row was keyed by the
    // token, so there was nothing to update. The row is keyed by
    // `device_key` now, so a token-less device reports everything the
    // report actually reads — platform, app_version, last_seen_at,
    // geofence_permission — and the two populations this used to lose,
    // every Android device and every iOS user who declined notifications,
    // become visible.
    const res = await postDeviceState({ token, deviceKey, geofencePermission })

    if (!token) {
      // Same `{ skipped, reason }` contract as before for the token — the
      // caller fires and forgets either way — but the state DID land, and
      // `result` is carried so LocationGate can latch it (see the note in
      // registerForPushNotifications).
      return { skipped: true, reason: tokenReason, reported: res != null, result: res }
    }
    return { token, result: res }
  } catch (err) {
    return { skipped: true, reason: `report_error: ${err?.message || err}` }
  }
}

export async function unregisterPushNotifications(token, deviceKey) {
  // ANDROID-VIS.1 — either identity will do (mig 565). The server prefers
  // device_key when both arrive, and scopes the delete to the caller's own
  // user_id either way.
  if (!token && !deviceKey) return { skipped: true }
  return api('/api/mobile/device-tokens', {
    method: 'DELETE',
    body: {
      ...(token ? { expo_push_token: token } : {}),
      ...(deviceKey ? { device_key: deviceKey } : {}),
    },
  })
}

// Derive this device's CURRENT Expo push token and delete its CRM
// registration. Called from signOut — BEFORE supabase.auth.signOut(),
// because the authed DELETE rides the still-valid JWT (the server
// scopes the delete to the calling user_id). Every failure mode skips
// silently: a device that never registered (simulator, permission
// denied, no token) has nothing to delete, and sign-out must never
// block on push bookkeeping. Without this, a shared/studio device
// keeps receiving the previous user's notifications after sign-out —
// the token stays valid, so the server's DeviceNotRegistered pruning
// never fires for it.
export async function unregisterCurrentDevicePush() {
  try {
    if (!Device.isDevice) return { skipped: true, reason: 'simulator' }

    // ANDROID-VIS.1 — peek, never mint: creating an identity for a device
    // we are about to deregister would be backwards, and a device with no
    // stored key has no row to delete under one.
    const deviceKey = await peekDeviceKey()

    const { status } = await Notifications.getPermissionsAsync()
    if (status !== 'granted') {
      // No permission ⇒ no token was ever uploaded. Before mig 565 that
      // meant no row existed at all and there was nothing to do; now a
      // token-less row DOES exist and leaving it behind would keep naming
      // the person signing out as its owner in the fleet report. Delete it
      // by key if we have one.
      if (!deviceKey) return { skipped: true, reason: 'permission_not_granted' }
      return await unregisterPushNotifications(null, deviceKey)
    }

    const projectId = Constants.expoConfig?.extra?.eas?.projectId
    let token
    try {
      const result = await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined
      )
      token = result?.data
    } catch {
      // Token unobtainable (Android without FCM). The device_key below is
      // still a valid handle on the row — this is exactly the case that
      // used to throw straight out to the catch and leave the row.
    }
    return await unregisterPushNotifications(token, deviceKey)
  } catch (err) {
    return { skipped: true, reason: `unregister_error: ${err?.message || err}` }
  }
}
