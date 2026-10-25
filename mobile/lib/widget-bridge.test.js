// mobile/lib/widget-bridge.test.js
// WIDGET.1 — the App Group bridge. Mocked the same way push-register.test.js
// mocks expo-device/expo-notifications, so this stays node-runnable
// alongside the rest of mobile/lib's pure tests (no RN component runner
// exists here — this is deliberately pure logic, not a rendered screen).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = vi.hoisted(() => ({ data: {} }))

// 🔴 The mock MUST model `get()` returning a STRING. The real
// ExtensionStorage's type is `get(key): string | null` — the native side
// JSON-encodes on set and hands back a string. A mock that returns the object
// it was given is more permissive than reality, and would let a bridge that
// forgot to encode/parse pass here and fail on device.
vi.mock('@bacons/apple-targets', () => ({
  ExtensionStorage: class {
    constructor(groupId) { this.groupId = groupId }
    set(key, value) {
      store.data[key] = typeof value === 'string' ? value : JSON.stringify(value)
    }
    get(key) {
      const v = store.data[key]
      if (v == null) return null
      if (typeof v !== 'string') throw new Error('ExtensionStorage.get must return a string')
      return v
    }
    remove(key) { delete store.data[key] }
    static reloadWidget = vi.fn()
  },
}))

// The module reads the resolved App Group off `Constants.expoConfig.ios.entitlements`
// (mirrors mobile/app.config.js's shape). Default to the public entitlement;
// the legacy-build test below re-mocks this to the legacy id.
vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      ios: {
        entitlements: {
          'com.apple.security.application-groups': ['group.ie.repset.widgets'],
        },
      },
    },
  },
}))

import { ExtensionStorage } from '@bacons/apple-targets'
import {
  APP_GROUP,
  storeWidgetCredential,
  listStoredStudios,
  removeWidgetCredential,
  reloadWidgets,
} from './widget-bridge'

beforeEach(() => {
  store.data = {}
  vi.clearAllMocks()
})

describe('storeWidgetCredential / listStoredStudios', () => {
  it('stores a credential keyed by location id, and lists it back', () => {
    storeWidgetCredential({
      locationId: 'loc-1', locationName: 'Stillorgan', tokenId: 't1', token: 'rwt_abc',
    })
    const studios = listStoredStudios()
    expect(studios).toEqual([
      { locationId: 'loc-1', locationName: 'Stillorgan', tokenId: 't1', token: 'rwt_abc' },
    ])
  })

  it('overwrites the same location rather than duplicating it', () => {
    storeWidgetCredential({ locationId: 'loc-1', locationName: 'Stillorgan', tokenId: 't1', token: 'rwt_old' })
    storeWidgetCredential({ locationId: 'loc-1', locationName: 'Stillorgan', tokenId: 't2', token: 'rwt_new' })
    const studios = listStoredStudios()
    expect(studios).toHaveLength(1)
    expect(studios[0].token).toBe('rwt_new')
  })

  it('holds more than one studio at once', () => {
    storeWidgetCredential({ locationId: 'loc-1', locationName: 'Stillorgan', tokenId: 't1', token: 'rwt_a' })
    storeWidgetCredential({ locationId: 'loc-2', locationName: 'Hatch Street', tokenId: 't2', token: 'rwt_b' })
    expect(listStoredStudios().map((s) => s.locationId).sort()).toEqual(['loc-1', 'loc-2'])
  })

  it('returns an empty list with nothing stored', () => {
    expect(listStoredStudios()).toEqual([])
  })

  it('survives a corrupt stored value rather than throwing', () => {
    store.data.repset_widget_studios = '{not json'
    expect(listStoredStudios()).toEqual([])
  })
})

describe('removeWidgetCredential', () => {
  it('drops one studio and leaves the rest', () => {
    storeWidgetCredential({ locationId: 'loc-1', locationName: 'A', tokenId: 't1', token: 'rwt_a' })
    storeWidgetCredential({ locationId: 'loc-2', locationName: 'B', tokenId: 't2', token: 'rwt_b' })
    removeWidgetCredential('loc-1')
    expect(listStoredStudios().map((s) => s.locationId)).toEqual(['loc-2'])
  })

  it('is a no-op for a location that was never stored', () => {
    storeWidgetCredential({ locationId: 'loc-1', locationName: 'A', tokenId: 't1', token: 'rwt_a' })
    removeWidgetCredential('loc-nope')
    expect(listStoredStudios()).toHaveLength(1)
  })
})

describe('reloadWidgets', () => {
  it('reloads all timelines via ExtensionStorage', () => {
    reloadWidgets()
    expect(ExtensionStorage.reloadWidget).toHaveBeenCalledWith()
  })

  it('never throws when the native module is unavailable (e.g. Expo Go)', () => {
    ExtensionStorage.reloadWidget.mockImplementationOnce(() => { throw new Error('no native module') })
    expect(() => reloadWidgets()).not.toThrow()
  })
})

describe('APP_GROUP', () => {
  it('matches the entitlement declared in app.config.js', () => {
    // Hand-checked against mobile/app.config.js ios.entitlements — there is
    // no runtime way to read the OTHER side of this pairing from a test, so
    // this assertion is a tripwire: change one without the other and this
    // still passes, which is exactly why the app.config.js comment on the
    // entitlement points back at this constant by name.
    expect(APP_GROUP).toBe('group.ie.repset.widgets')
  })

  it('follows the manifest, so the legacy build gets its own group', () => {
    // The whole point: a hard-coded id would silently break the legacy app.
    // Drive this by mocking expo-constants with the LEGACY_APP entitlement and
    // re-importing the module (vi.resetModules + dynamic import).
    expect(APP_GROUP).toMatch(/^group\./)
  })

  it('reads group.com.un1tdublin.crm.widgets when the manifest carries the LEGACY_APP entitlement', async () => {
    // A top-level `import` is hoisted and evaluated once, so it can never see
    // a mock changed mid-test-run — only vi.resetModules() + a dynamic
    // import() re-evaluates the module against the new mock. This is the
    // single most important test in the file: a hard-coded APP_GROUP would
    // make the legacy app's bridge open a container it does not hold, so its
    // widget would silently do nothing for exactly the installed base the
    // two-build rule exists to protect.
    vi.resetModules()
    vi.doMock('expo-constants', () => ({
      default: {
        expoConfig: {
          ios: {
            entitlements: {
              'com.apple.security.application-groups': ['group.com.un1tdublin.crm.widgets'],
            },
          },
        },
      },
    }))
    try {
      const legacy = await import('./widget-bridge')
      expect(legacy.APP_GROUP).toBe('group.com.un1tdublin.crm.widgets')
    } finally {
      vi.doUnmock('expo-constants')
      vi.resetModules()
    }
  })
})
