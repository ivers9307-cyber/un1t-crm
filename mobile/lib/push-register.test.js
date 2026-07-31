// Tests for unregisterCurrentDevicePush() — the signOut-time token
// cleanup (2026-06 audit: sign-out previously left the device token
// registered, so shared/studio devices kept receiving the previous
// user's notifications until the token rotated). Expo modules are
// factory-mocked so the suite stays node-runnable alongside the rest
// of mobile/lib's pure tests.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  isDevice: true,
  permission: 'granted',
  token: 'ExponentPushToken[abc]',
  tokenThrows: false,
  pairing: null,
}))

vi.mock('expo-device', () => ({
  get isDevice() { return state.isDevice },
  deviceName: 'Test iPhone',
}))
vi.mock('expo-notifications', () => ({
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: vi.fn(async () => ({ status: state.permission })),
  requestPermissionsAsync: vi.fn(async () => ({ status: state.permission })),
  getExpoPushTokenAsync: vi.fn(async () => {
    if (state.tokenThrows) throw new Error('no apns')
    return { data: state.token }
  }),
  setNotificationChannelAsync: vi.fn(),
  AndroidImportance: { DEFAULT: 3 },
}))
vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: '1.3.0', extra: { eas: { projectId: 'proj-1' } } } },
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('./api', () => ({ api: vi.fn(async () => ({ success: true })) }))
vi.mock('./studio-device', () => ({
  getPairing: vi.fn(async () => state.pairing),
}))

import { registerForPushNotifications, reportDeviceState, unregisterCurrentDevicePush, unregisterPushNotifications } from './push-register'
import { api } from './api'
import * as Notifications from 'expo-notifications'

beforeEach(() => {
  vi.clearAllMocks()
  state.isDevice = true
  state.permission = 'granted'
  state.token = 'ExponentPushToken[abc]'
  state.tokenThrows = false
  state.pairing = null
})

describe('registerForPushNotifications — studio-device guard', () => {
  it('skips entirely on a paired studio device — no permission prompt, no token upload', async () => {
    state.pairing = { token: 'x'.repeat(32), label: 'Reception iPad' }
    const res = await registerForPushNotifications()
    expect(res).toEqual({ skipped: true, reason: 'studio_device' })
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled()
    expect(api).not.toHaveBeenCalled()
  })

  it('registers normally on an unpaired personal device', async () => {
    const res = await registerForPushNotifications()
    expect(res.token).toBe('ExponentPushToken[abc]')
    expect(api).toHaveBeenCalledWith('/api/mobile/device-tokens', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({ expo_push_token: 'ExponentPushToken[abc]' }),
    }))
  })
})

describe('reportDeviceState — STAFF-DEV.7 permission + version reporting', () => {
  it('reports the permission and the app version without prompting for anything', async () => {
    const res = await reportDeviceState({ geofencePermission: 'always' })
    expect(res.token).toBe('ExponentPushToken[abc]')
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(api).toHaveBeenCalledWith('/api/mobile/device-tokens', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        expo_push_token: 'ExponentPushToken[abc]',
        app_version: '1.3.0',
        geofence_permission: 'always',
      }),
    }))
  })

  it('omits geofence_permission when the caller has no value', async () => {
    await reportDeviceState()
    const body = api.mock.calls[0][1].body
    expect(Object.keys(body)).not.toContain('geofence_permission')
  })

  it('skips on a paired studio device — never writes under the last PIN-unlocker', async () => {
    state.pairing = { token: 'x'.repeat(32), label: 'Reception iPad' }
    const res = await reportDeviceState({ geofencePermission: 'always' })
    expect(res).toEqual({ skipped: true, reason: 'studio_device' })
    expect(api).not.toHaveBeenCalled()
  })

  it('skips on simulators and when the token lookup throws, without throwing', async () => {
    state.isDevice = false
    expect((await reportDeviceState({ geofencePermission: 'denied' })).skipped).toBe(true)
    state.isDevice = true
    state.tokenThrows = true
    expect((await reportDeviceState({ geofencePermission: 'denied' })).skipped).toBe(true)
    expect(api).not.toHaveBeenCalled()
  })

  it('skips when the device returns an empty token', async () => {
    state.token = null
    expect((await reportDeviceState({ geofencePermission: 'always' })).skipped).toBe(true)
    expect(api).not.toHaveBeenCalled()
  })
})

describe('unregisterCurrentDevicePush — signOut token cleanup', () => {
  it('deletes the current token via the authed API when registered', async () => {
    const res = await unregisterCurrentDevicePush()
    expect(api).toHaveBeenCalledWith('/api/mobile/device-tokens', {
      method: 'DELETE',
      body: { expo_push_token: 'ExponentPushToken[abc]' },
    })
    expect(res).toEqual({ success: true })
  })

  it('skips on simulators (nothing was ever registered)', async () => {
    state.isDevice = false
    const res = await unregisterCurrentDevicePush()
    expect(res.skipped).toBe(true)
    expect(api).not.toHaveBeenCalled()
  })

  it('skips when notification permission was never granted', async () => {
    state.permission = 'denied'
    const res = await unregisterCurrentDevicePush()
    expect(res.skipped).toBe(true)
    expect(api).not.toHaveBeenCalled()
  })

  it('skips quietly when the token lookup throws — never blocks sign-out', async () => {
    state.tokenThrows = true
    const res = await unregisterCurrentDevicePush()
    expect(res.skipped).toBe(true)
    expect(api).not.toHaveBeenCalled()
  })

  it('skips when the device returns an empty token', async () => {
    state.token = null
    const res = await unregisterCurrentDevicePush()
    expect(res.skipped).toBe(true)
    expect(api).not.toHaveBeenCalled()
  })
})

describe('unregisterPushNotifications (existing behavior pin)', () => {
  it('no-ops without a token', async () => {
    const res = await unregisterPushNotifications(null)
    expect(res).toEqual({ skipped: true })
    expect(api).not.toHaveBeenCalled()
  })
})
