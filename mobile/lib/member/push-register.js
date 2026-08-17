import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import Constants from 'expo-constants'
import { Platform } from 'react-native'
import { api } from './api'
import { CUSTOMER_ANDROID_CHANNELS } from 'shared/customer-push-channels'

export async function registerForPushNotifications() {
  if (!Device.isDevice) return { skipped: true, reason: 'simulator' }
  const { status: existing } = await Notifications.getPermissionsAsync()
  let final = existing
  if (existing !== 'granted') final = (await Notifications.requestPermissionsAsync()).status
  if (final !== 'granted') return { skipped: true, reason: 'permission_denied' }
  // Android needs channels before tokens work. Create every per-type channel
  // (shared/customer-push-channels.js — the same map both servers derive each
  // message's channelId from). Idempotent per id, but channels are IMMUTABLE
  // once created on a device: re-registering an existing id with a new spec is
  // a no-op, and importance can never be raised later — a re-spec needs a NEW
  // channel id.
  if (Platform.OS === 'android') {
    for (const [id, spec] of Object.entries(CUSTOMER_ANDROID_CHANNELS)) {
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
  // NEEDS-RICHARD (P0-4c): on Android getExpoPushTokenAsync throws until FCM is
  // configured. The app.config.js android.googleServicesFile pointer is now in
  // place but env-gated, and the FCM V1 service-account key must be uploaded to
  // EAS credentials. Until an owner completes docs/ANDROID_PUSH_SETUP.md, push
  // no-ops on Android (caught below → { skipped, reason: 'token_error' }, now
  // logged so the failure is observable). iOS is unaffected.
  try {
    token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data
  } catch (e) {
    // Log so the failure is observable in device/EAS logs instead of silently
    // no-oping — on Android this fires until FCM is configured (see above).
    console.warn('[push-register] expo token failed', { platform: Platform.OS, err: String(e?.message || e) })
    return { skipped: true, reason: `token_error: ${e.message || e}` }
  }
  if (!token) return { skipped: true, reason: 'no_token' }
  const res = await api('/api/mobile/push-token', { method: 'POST', body: { expo_push_token: token, platform: Platform.OS, device_name: Device.deviceName || undefined, app_version: Constants.expoConfig?.version } })
  return { token, result: res }
}

export async function unregisterCurrentDevicePush() {
  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId
    const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data
    if (token) await api('/api/mobile/push-token', { method: 'DELETE', body: { expo_push_token: token } })
  } catch { /* best-effort */ }
}

export async function getPushPermission() {
  const { status } = await Notifications.getPermissionsAsync()
  return status
}
