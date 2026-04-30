// Register / unregister this device's Expo push token with the CRM.
//
// Call registerForPushNotifications() after a successful login (with
// permissions.mobile.push_notifications enabled). Call
// unregisterPushNotifications() on signOut.
//
// On iOS, requesting permission shows the system "Allow Notifications?"
// modal the first time. If the user declines, we silently exit — they
// can re-enable later from iOS Settings → UN1T CRM → Notifications.
//
// In Expo Go (dev), the token is an Expo-channel token; in a custom
// build with Apple Developer credentials, it's an APNs-backed Expo
// token. Either way the format is ExponentPushToken[xxx].

import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import Constants from 'expo-constants'
import { Platform } from 'react-native'
import { api } from './api'

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

export async function registerForPushNotifications() {
  if (!Device.isDevice) {
    // Simulators don't get real push tokens. Skip silently.
    return { skipped: true, reason: 'simulator' }
  }

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

  // Android needs an explicit channel before tokens work.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
    })
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
    },
  })

  return { token, result: res }
}

export async function unregisterPushNotifications(token) {
  if (!token) return { skipped: true }
  return api('/api/mobile/device-tokens', {
    method: 'DELETE',
    body: { expo_push_token: token },
  })
}
