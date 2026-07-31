// Register / unregister this device's Expo push token with the CRM.
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
import { ANDROID_CHANNELS } from 'shared/push-channels'

// Show notifications even when the app is in the foreground (default
// is to silence them). Iconic "banner from the top" iOS behaviour.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
})

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

  const projectId = Constants.expoConfig?.extra?.eas?.projectId
  let token
  try {
    const result = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    )
    token = result.data
  } catch (err) {
    return { skipped: true, reason: `token_error: ${err.message || err}` }
  }

  if (!token) return { skipped: true, reason: 'no_token' }

  // Register with the CRM. Idempotent server-side (upsert by token).
  const res = await api('/api/mobile/device-tokens', {
    method: 'POST',
    body: {
      expo_push_token: token,
      platform: Platform.OS,
      device_name: Device.deviceName || undefined,
      app_version: Constants.expoConfig?.version,
      // Only sent when the caller actually knows it — see reportDeviceState.
      ...(opts.geofencePermission ? { geofence_permission: opts.geofencePermission } : {}),
    },
  })

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
 * expo_push_token) so it refreshes the existing row rather than making
 * a second one, and never prompts for anything: it only reports when a
 * token can already be derived.
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

    // Same kiosk carve-out as registration: a shared studio device must
    // never write a row under whichever staffer last PIN-unlocked it.
    try {
      const { getPairing } = await import('./studio-device')
      if (await getPairing()) return { skipped: true, reason: 'studio_device' }
    } catch { /* SecureStore unreadable ⇒ treat as unpaired */ }

    const projectId = Constants.expoConfig?.extra?.eas?.projectId
    let token
    try {
      const result = await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined
      )
      token = result?.data
    } catch (err) {
      // iOS refuses a token without notification permission. Nothing to
      // update in that case — the row is keyed by the token.
      return { skipped: true, reason: `token_error: ${err?.message || err}` }
    }
    if (!token) return { skipped: true, reason: 'no_token' }

    const res = await api('/api/mobile/device-tokens', {
      method: 'POST',
      body: {
        expo_push_token: token,
        platform: Platform.OS,
        device_name: Device.deviceName || undefined,
        app_version: Constants.expoConfig?.version,
        ...(geofencePermission ? { geofence_permission: geofencePermission } : {}),
      },
    })
    return { token, result: res }
  } catch (err) {
    return { skipped: true, reason: `report_error: ${err?.message || err}` }
  }
}

export async function unregisterPushNotifications(token) {
  if (!token) return { skipped: true }
  return api('/api/mobile/device-tokens', {
    method: 'DELETE',
    body: { expo_push_token: token },
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

    const { status } = await Notifications.getPermissionsAsync()
    if (status !== 'granted') {
      // Never granted ⇒ registerForPushNotifications never uploaded a
      // token for this device ⇒ nothing to delete server-side.
      return { skipped: true, reason: 'permission_not_granted' }
    }

    const projectId = Constants.expoConfig?.extra?.eas?.projectId
    const result = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    )
    return await unregisterPushNotifications(result?.data)
  } catch (err) {
    return { skipped: true, reason: `unregister_error: ${err?.message || err}` }
  }
}
