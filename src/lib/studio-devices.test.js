// STUDIO-PIN.1 — coverage for the device-token primitives and the
// per-device lockout calculation. The hash round-trip, constant-time
// comparison, and the 5-strike threshold are the cases that matter.

import { describe, it, expect } from 'vitest'
import {
  generateDeviceToken,
  hashDeviceToken,
  deviceTokenMatches,
  findDeviceByToken,
  getDeviceLockoutState,
  STUDIO_LOCKOUT,
} from './studio-devices'

describe('generateDeviceToken + hashDeviceToken', () => {
  it('produces a base64url token + matching hash', () => {
    const { token, hash } = generateDeviceToken()
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThanOrEqual(40) // 32 bytes base64url
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true)
    expect(hash).toBe(hashDeviceToken(token))
  })

  it('produces a unique token each call', () => {
    const a = generateDeviceToken()
    const b = generateDeviceToken()
    expect(a.token).not.toBe(b.token)
    expect(a.hash).not.toBe(b.hash)
  })

  it('hash is a 64-char hex string (sha256)', () => {
    const { hash } = generateDeviceToken()
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true)
  })

  it('throws on too-short input', () => {
    expect(() => hashDeviceToken('short')).toThrow(/non-empty/)
    expect(() => hashDeviceToken('')).toThrow(/non-empty/)
  })
})

describe('deviceTokenMatches', () => {
  it('matches the same token', () => {
    const { token, hash } = generateDeviceToken()
    expect(deviceTokenMatches(token, hash)).toBe(true)
  })

  it('rejects a different token', () => {
    const { token } = generateDeviceToken()
    const { hash: otherHash } = generateDeviceToken()
    expect(deviceTokenMatches(token, otherHash)).toBe(false)
  })

  it('rejects malformed input', () => {
    expect(deviceTokenMatches(null, 'abc')).toBe(false)
    expect(deviceTokenMatches('abc', null)).toBe(false)
    expect(deviceTokenMatches('abc', 'not-hex')).toBe(false)
    expect(deviceTokenMatches('abc', '00')).toBe(false) // length mismatch
  })
})

describe('findDeviceByToken', () => {
  const buildDb = (devices) => ({
    from() { return this },
    select() { return this },
    is() {
      return Promise.resolve({ data: devices, error: null })
    },
  })

  it('returns null when no devices are paired', async () => {
    const db = buildDb([])
    expect(await findDeviceByToken({ db, token: 'whatever' })).toBeNull()
  })

  it('returns the matching device', async () => {
    const { token, hash } = generateDeviceToken()
    const db = buildDb([
      { id: 'd1', label: 'Reception Mac', device_token_hash: hash },
    ])
    const got = await findDeviceByToken({ db, token })
    expect(got?.id).toBe('d1')
  })

  it('returns null when token doesn’t match any device', async () => {
    const { hash } = generateDeviceToken()
    const db = buildDb([
      { id: 'd1', device_token_hash: hash },
    ])
    const got = await findDeviceByToken({ db, token: 'different-token-string-32-bytes-long' })
    expect(got).toBeNull()
  })

  it('returns null on malformed input', async () => {
    const db = buildDb([])
    expect(await findDeviceByToken({ db, token: null })).toBeNull()
    expect(await findDeviceByToken({ db, token: 'x' })).toBeNull()
  })

  it('surfaces db errors', async () => {
    const db = {
      from() { return this },
      select() { return this },
      is() {
        return Promise.resolve({ data: null, error: { message: 'db down' } })
      },
    }
    await expect(
      findDeviceByToken({ db, token: 'whatever-long-enough-token-string-12345' }),
    ).rejects.toThrow('db down')
  })
})

describe('getDeviceLockoutState', () => {
  const buildDb = (rows) => ({
    from() { return this },
    select() { return this },
    eq() { return this },
    gte() { return this },
    order() {
      return Promise.resolve({ data: rows, error: null })
    },
  })

  it('reports unlocked when below threshold', async () => {
    const db = buildDb([
      { attempted_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
      { attempted_at: new Date(Date.now() - 8 * 60 * 1000).toISOString() },
    ])
    const state = await getDeviceLockoutState({ db, deviceId: 'd1' })
    expect(state.locked).toBe(false)
    expect(state.recentFailures).toBe(2)
  })

  it('reports locked at exactly the threshold', async () => {
    const now = new Date('2026-06-01T10:00:00Z')
    const latest = new Date(now.getTime() - 1 * 60 * 1000)
    const rows = Array.from({ length: STUDIO_LOCKOUT.threshold }, (_, i) => ({
      attempted_at: new Date(latest.getTime() - i * 30 * 1000).toISOString(),
    }))
    const db = buildDb(rows)
    const state = await getDeviceLockoutState({ db, deviceId: 'd1', now })
    expect(state.locked).toBe(true)
    expect(state.recentFailures).toBe(STUDIO_LOCKOUT.threshold)
    // retryAfter is 15 min after the most recent attempt (not now).
    expect(state.retryAfter).toBe(
      new Date(latest.getTime() + STUDIO_LOCKOUT.windowMs).toISOString(),
    )
  })

  it('reports locked above the threshold', async () => {
    const rows = Array.from({ length: STUDIO_LOCKOUT.threshold + 3 }, () => ({
      attempted_at: new Date().toISOString(),
    }))
    const db = buildDb(rows)
    const state = await getDeviceLockoutState({ db, deviceId: 'd1' })
    expect(state.locked).toBe(true)
    expect(state.recentFailures).toBe(STUDIO_LOCKOUT.threshold + 3)
  })

  it('surfaces db errors', async () => {
    const db = {
      from() { return this },
      select() { return this },
      eq() { return this },
      gte() { return this },
      order() {
        return Promise.resolve({ data: null, error: { message: 'db down' } })
      },
    }
    await expect(
      getDeviceLockoutState({ db, deviceId: 'd1' }),
    ).rejects.toThrow('db down')
  })
})

describe('STUDIO_LOCKOUT constants', () => {
  it('exposes the policy numbers', () => {
    expect(STUDIO_LOCKOUT.threshold).toBe(5)
    expect(STUDIO_LOCKOUT.windowMs).toBe(15 * 60 * 1000)
  })

  it('is frozen', () => {
    expect(() => {
      STUDIO_LOCKOUT.threshold = 99
    }).toThrow()
  })
})
