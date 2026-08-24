// ANDROID-VIS.1 — the per-install device identity that replaced the Expo
// push token as the device_tokens conflict key (mig 565). The shape is
// load-bearing: the server route rejects anything that isn't 32 lowercase
// hex, so a generator that can emit a shorter/odd string would make a
// device silently unreportable — the exact failure this whole change
// exists to remove.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = vi.hoisted(() => ({ value: null, readThrows: false, writeThrows: false }))

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => {
    if (store.readThrows) throw new Error('keychain locked')
    return store.value
  }),
  setItemAsync: vi.fn(async (_k, v) => {
    if (store.writeThrows) throw new Error('keychain full')
    store.value = v
  }),
}))

import {
  generateDeviceKey,
  isValidDeviceKey,
  getDeviceKey,
  peekDeviceKey,
  DEVICE_KEY_PATTERN,
} from './device-key'
import * as SecureStore from 'expo-secure-store'

beforeEach(() => {
  vi.clearAllMocks()
  store.value = null
  store.readThrows = false
  store.writeThrows = false
})

describe('generateDeviceKey', () => {
  it('always emits exactly 32 lowercase hex characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateDeviceKey()).toMatch(DEVICE_KEY_PATTERN)
    }
  })

  it('pads short random draws rather than emitting a short key', () => {
    // Math.random() === 0 is legal and the worst case for a naive
    // toString(16) — it yields '0', not eight characters.
    expect(generateDeviceKey(() => 0, () => 0)).toBe('0'.repeat(32))
  })

  it('handles the top of the random range without overflowing the length', () => {
    const key = generateDeviceKey(() => 0.9999999, () => 8640000000000)
    expect(key).toMatch(DEVICE_KEY_PATTERN)
    expect(key).toHaveLength(32)
  })

  it('does not repeat itself across calls within the same millisecond', () => {
    const fixedClock = () => 1_700_000_000_000
    const keys = new Set(Array.from({ length: 500 }, () => generateDeviceKey(Math.random, fixedClock)))
    expect(keys.size).toBe(500)
  })
})

describe('isValidDeviceKey', () => {
  it('accepts a freshly generated key', () => {
    expect(isValidDeviceKey(generateDeviceKey())).toBe(true)
  })

  it.each([
    ['uppercase hex', 'A'.repeat(32)],
    ['too short', 'a'.repeat(31)],
    ['too long', 'a'.repeat(33)],
    ['non-hex', 'z'.repeat(32)],
    ['null', null],
    ['undefined', undefined],
    ['a number', 12345],
  ])('rejects %s', (_label, value) => {
    expect(isValidDeviceKey(value)).toBe(false)
  })
})

describe('getDeviceKey', () => {
  it('mints and persists on first call, then returns the SAME key', async () => {
    const first = await getDeviceKey()
    expect(first).toMatch(DEVICE_KEY_PATTERN)
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('device_installation_key', first)

    const second = await getDeviceKey()
    expect(second).toBe(first)
    // A stable identity is the entire point — one write, ever.
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1)
  })

  it('replaces a corrupt stored value rather than reporting it', async () => {
    store.value = 'not-a-device-key'
    const key = await getDeviceKey()
    expect(key).toMatch(DEVICE_KEY_PATTERN)
    expect(key).not.toBe('not-a-device-key')
  })

  it('still returns a usable key when the keychain cannot be read', async () => {
    store.readThrows = true
    const key = await getDeviceKey()
    expect(key).toMatch(DEVICE_KEY_PATTERN)
  })

  it('still returns a key when it cannot be persisted — an extra row beats an invisible device', async () => {
    store.writeThrows = true
    const key = await getDeviceKey()
    expect(key).toMatch(DEVICE_KEY_PATTERN)
  })
})

describe('peekDeviceKey', () => {
  it('returns null instead of minting when nothing is stored', async () => {
    expect(await peekDeviceKey()).toBeNull()
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
  })

  it('returns the stored key when there is one', async () => {
    const key = await getDeviceKey()
    expect(await peekDeviceKey()).toBe(key)
  })

  it('returns null on an unreadable keychain', async () => {
    store.readThrows = true
    expect(await peekDeviceKey()).toBeNull()
  })
})
