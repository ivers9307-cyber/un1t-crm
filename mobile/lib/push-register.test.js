// Tests for unregisterCurrentDevicePush() — the signOut-time token
// cleanup (2026-06 audit: sign-out previously left the device token
// registered, so shared/studio devices kept receiving the previous
// user's notifications until the token rotated). Expo modules are
// factory-mocked so the suite stays node-runnable alongside the rest
// of mobile/lib's pure tests.
//
// ANDROID-VIS.1 (mig 565) — plus the token-less reporting path. Several
// cases below used to assert `api` was NOT called when a push token could
// not be derived; that assertion WAS the bug (13 iOS rows, zero Android
// rows ever), so they now assert the opposite and pin what gets sent.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  isDevice: true,
  permission: 'granted',
  token: 'ExponentPushToken[abc]',
  tokenThrows: false,
  pairing: null,
  impersonate: null,
  deviceKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  // REPSET-PUB.1A — Constants.nativeBuildVersion. Null on a simulator or
  // any host that cannot read the binary's Info.plist.
  nativeBuild: '42',
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
  default: {
    expoConfig: { version: '1.3.0', extra: { eas: { projectId: 'proj-1' } } },
    get nativeBuildVersion() { return state.nativeBuild },
  },
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('./api', () => ({ api: vi.fn(async () => ({ success: true })) }))
vi.mock('./studio-device', () => ({
  getPairing: vi.fn(async () => state.pairing),
}))
vi.mock('./impersonate', () => ({
  readImpersonate: vi.fn(async () => state.impersonate),
}))
vi.mock('./device-key', () => ({
  getDeviceKey: vi.fn(async () => state.deviceKey),
  peekDeviceKey: vi.fn(async () => state.deviceKey),
}))

import { registerForPushNotifications, reportDeviceState, unregisterCurrentDevicePush, unregisterPushNotifications } from './push-register'
import { api } from './api'
import { readImpersonate } from './impersonate'
import * as Notifications from 'expo-notifications'
import { isGenuinePushSuccess } from 'shared/push-registration'

beforeEach(() => {
  vi.clearAllMocks()
  state.isDevice = true
  state.permission = 'granted'
  state.token = 'ExponentPushToken[abc]'
  state.tokenThrows = false
  state.pairing = null
  state.impersonate = null
  state.deviceKey = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  state.nativeBuild = '42'
})

const DEVICE_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

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
      body: expect.objectContaining({
        expo_push_token: 'ExponentPushToken[abc]',
        // ANDROID-VIS.1 — sent alongside the token so the server can adopt
        // this device's existing token-keyed row into a stable identity.
        device_key: DEVICE_KEY,
      }),
    }))
  })

  it('ANDROID-VIS.1 — registers the device even when no token can be obtained', async () => {
    state.tokenThrows = true
    const res = await registerForPushNotifications({ geofencePermission: 'when_in_use' })
    expect(res).toMatchObject({ skipped: true, reported: true })
    expect(res.reason).toMatch(/^token_error:/)
    expect(api).toHaveBeenCalledWith('/api/mobile/device-tokens', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({ device_key: DEVICE_KEY, app_version: '1.3.0' }),
    }))
  })

  it('still counts as NOT a genuine success, so the launch latch keeps retrying', async () => {
    state.tokenThrows = true
    const res = await registerForPushNotifications()
    expect(isGenuinePushSuccess(res)).toBe(false)
  })

  it('never registers when the notification prompt is declined', async () => {
    // Unchanged: reportDeviceState is the path that covers this user, and
    // it does not prompt. Registration must not create a row off the back
    // of a refusal.
    state.permission = 'denied'
    const res = await registerForPushNotifications()
    expect(res).toEqual({ skipped: true, reason: 'permission_denied' })
    expect(api).not.toHaveBeenCalled()
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

  it('skips mid-impersonation — the upsert would re-point the token to the target', async () => {
    // The row's conflict target is expo_push_token, and api() attaches
    // x-impersonate-target straight from SecureStore, so a report sent
    // while viewing-as would move THIS phone's row onto the target's
    // user_id: the master would start receiving the target's WhatsApp
    // and lead pushes (customer PII) and stop receiving their own.
    // SecureStore is read directly because the caller's React state is
    // still null during the cold-start window this runs in.
    state.impersonate = { targetId: 'target-uuid', startedAt: new Date().toISOString() }
    const res = await reportDeviceState({ geofencePermission: 'always' })
    expect(res).toEqual({ skipped: true, reason: 'impersonating' })
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled()
    expect(api).not.toHaveBeenCalled()
  })

  it('reports normally when the impersonation blob is unreadable', async () => {
    readImpersonate.mockRejectedValueOnce(new Error('SecureStore unavailable'))
    const res = await reportDeviceState({ geofencePermission: 'always' })
    expect(res.token).toBe('ExponentPushToken[abc]')
    expect(api).toHaveBeenCalled()
  })

  it('skips on a simulator — no real device, nothing to report', async () => {
    state.isDevice = false
    expect((await reportDeviceState({ geofencePermission: 'denied' })).skipped).toBe(true)
    expect(api).not.toHaveBeenCalled()
  })

  it('ANDROID-VIS.1 — STILL REPORTS when the token lookup throws', async () => {
    // This is the Android case verbatim: getExpoPushTokenAsync throws for
    // want of FCM credentials. It used to return here, which is why
    // device_tokens held 13 iOS rows and zero Android rows ever. The
    // geofence permission and the app version are exactly what the fleet
    // report reads, and they now land.
    state.tokenThrows = true
    const res = await reportDeviceState({ geofencePermission: 'denied' })
    expect(res.skipped).toBe(true)
    expect(res.reason).toMatch(/^token_error:/)
    expect(res.reported).toBe(true)
    expect(api).toHaveBeenCalledWith('/api/mobile/device-tokens', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        device_key: DEVICE_KEY,
        app_version: '1.3.0',
        geofence_permission: 'denied',
      }),
    }))
    // Never sent as an explicit null: the server would then have to decide
    // whether to wipe a token it already holds.
    expect(Object.keys(api.mock.calls[0][1].body)).not.toContain('expo_push_token')
  })

  it('ANDROID-VIS.1 — still reports when the device returns an empty token', async () => {
    state.token = null
    const res = await reportDeviceState({ geofencePermission: 'always' })
    expect(res).toMatchObject({ skipped: true, reason: 'no_token', reported: true })
    expect(api).toHaveBeenCalled()
  })

  it('carries `result` on a token-less report so LocationGate can latch it', async () => {
    // Without this the gate never records the permission as reported and
    // re-POSTs on every single foreground.
    state.tokenThrows = true
    const res = await reportDeviceState({ geofencePermission: 'always' })
    expect(res.result).toEqual({ success: true })
  })

  it('reports nothing at all when there is neither a token nor a device key', async () => {
    // SecureStore unreadable AND unwritable. No identity ⇒ no row we could
    // address; reporting anyway would mint a duplicate on every launch.
    state.tokenThrows = true
    state.deviceKey = null
    const res = await reportDeviceState({ geofencePermission: 'always' })
    expect(res).toMatchObject({ skipped: true, reported: false })
    expect(api).not.toHaveBeenCalled()
  })
})

describe('unregisterCurrentDevicePush — signOut token cleanup', () => {
  it('deletes the current token via the authed API when registered', async () => {
    const res = await unregisterCurrentDevicePush()
    expect(api).toHaveBeenCalledWith('/api/mobile/device-tokens', {
      method: 'DELETE',
      body: { expo_push_token: 'ExponentPushToken[abc]', device_key: DEVICE_KEY },
    })
    expect(res).toEqual({ success: true })
  })

  it('skips on simulators (nothing was ever registered)', async () => {
    state.isDevice = false
    const res = await unregisterCurrentDevicePush()
    expect(res.skipped).toBe(true)
    expect(api).not.toHaveBeenCalled()
  })

  it('ANDROID-VIS.1 — deletes by device_key when permission was never granted', async () => {
    // Pre-565 there was no row in this case, so skipping was right. Now a
    // token-less row DOES exist, and leaving it would keep naming the
    // person signing out as its owner in the fleet report.
    state.permission = 'denied'
    const res = await unregisterCurrentDevicePush()
    expect(api).toHaveBeenCalledWith('/api/mobile/device-tokens', {
      method: 'DELETE',
      body: { device_key: DEVICE_KEY },
    })
    expect(res).toEqual({ success: true })
  })

  it('still skips when permission was never granted AND there is no device key', async () => {
    state.permission = 'denied'
    state.deviceKey = null
    const res = await unregisterCurrentDevicePush()
    expect(res.skipped).toBe(true)
    expect(api).not.toHaveBeenCalled()
  })

  it('ANDROID-VIS.1 — deletes by device_key when the token lookup throws', async () => {
    state.tokenThrows = true
    const res = await unregisterCurrentDevicePush()
    expect(api).toHaveBeenCalledWith('/api/mobile/device-tokens', {
      method: 'DELETE',
      body: { device_key: DEVICE_KEY },
    })
    expect(res).toEqual({ success: true })
  })

  it('deletes by device_key when the device returns an empty token', async () => {
    state.token = null
    await unregisterCurrentDevicePush()
    expect(api).toHaveBeenCalledWith('/api/mobile/device-tokens', {
      method: 'DELETE',
      body: { device_key: DEVICE_KEY },
    })
  })

  it('never mints a device key on the way out', async () => {
    // peekDeviceKey, not getDeviceKey: creating an identity for a device we
    // are about to deregister would be backwards.
    state.deviceKey = null
    state.tokenThrows = true
    const res = await unregisterCurrentDevicePush()
    expect(res.skipped).toBe(true)
    expect(api).not.toHaveBeenCalled()
  })
})

describe('unregisterPushNotifications (existing behavior pin)', () => {
  it('no-ops with neither identity', async () => {
    const res = await unregisterPushNotifications(null)
    expect(res).toEqual({ skipped: true })
    expect(api).not.toHaveBeenCalled()
  })

  it('sends only the identities it was given', async () => {
    await unregisterPushNotifications(null, DEVICE_KEY)
    expect(api).toHaveBeenCalledWith('/api/mobile/device-tokens', {
      method: 'DELETE',
      body: { device_key: DEVICE_KEY },
    })
  })
})

describe('native_build reporting — REPSET-PUB.1A', () => {
  // The binary's Info.plist build number is the ONLY OTA-immune signal that
  // separates the OLD unlisted iOS app from the NEW public `ie.repset.app`
  // one: app_version ships over the air and is identical on both, and
  // Constants.expoConfig reflects the OTA-delivered config, so an old binary
  // would report the NEW bundle id once the config PR publishes. Both entry
  // points must send it or the migration report cannot be built.

  it('registerForPushNotifications sends the native build', async () => {
    await registerForPushNotifications()
    expect(api.mock.calls[0][1].body.native_build).toBe('42')
  })

  it('reportDeviceState sends the native build', async () => {
    // This is the path LocationGate calls on every foreground, so it is the
    // one that actually populates the fleet.
    await reportDeviceState({ geofencePermission: 'always' })
    expect(api.mock.calls[0][1].body.native_build).toBe('42')
  })

  it('reports it even when no push token can be obtained', async () => {
    // Every Android device, and every iOS user who declined notifications.
    state.tokenThrows = true
    await reportDeviceState()
    expect(api.mock.calls[0][1].body.native_build).toBe('42')
  })

  it('OMITS the key when the host reports null (simulator)', async () => {
    // Sending null would make the server choose between wiping a build
    // number it already holds and ignoring the field; absence says
    // "nothing to report" and leaves the stored value alone.
    state.nativeBuild = null
    await reportDeviceState({ geofencePermission: 'always' })
    expect(Object.keys(api.mock.calls[0][1].body)).not.toContain('native_build')
  })

  it('OMITS the key when the host reports undefined or an empty string', async () => {
    for (const absent of [undefined, '']) {
      vi.clearAllMocks()
      state.nativeBuild = absent
      await reportDeviceState()
      expect(Object.keys(api.mock.calls[0][1].body)).not.toContain('native_build')
    }
  })

  it('coerces a numeric build to text — the column is text', async () => {
    // Android reports versionCode as a number.
    state.nativeBuild = 231
    await reportDeviceState()
    expect(api.mock.calls[0][1].body.native_build).toBe('231')
  })

  it('never blocks the report — a null build still sends everything else', async () => {
    state.nativeBuild = null
    await reportDeviceState({ geofencePermission: 'always' })
    expect(api.mock.calls[0][1].body).toMatchObject({
      device_key: DEVICE_KEY, app_version: '1.3.0', geofence_permission: 'always',
    })
  })
})
