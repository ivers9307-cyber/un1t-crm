// Tests for bridge-auth.js — token issuance, sha256 hashing,
// bearer-header parsing, DB lookup. We mock createServerClient
// because the lookup goes through Supabase.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}))

import { issueBridgeToken, sha256Hex, verifyBridgeToken } from './bridge-auth.js'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => {
  vi.clearAllMocks()
})

// ── issueBridgeToken ────────────────────────────────────────────

describe('issueBridgeToken', () => {
  it('returns { raw, hash } with the expected prefix and lengths', () => {
    const { raw, hash } = issueBridgeToken()
    expect(raw).toMatch(/^bbr_[A-Za-z0-9_-]+$/)
    expect(raw.length).toBeGreaterThanOrEqual(40)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('generates a different token each call', () => {
    const a = issueBridgeToken()
    const b = issueBridgeToken()
    expect(a.raw).not.toBe(b.raw)
    expect(a.hash).not.toBe(b.hash)
  })

  it('hash is the sha256 of the raw value', () => {
    const { raw, hash } = issueBridgeToken()
    expect(sha256Hex(raw)).toBe(hash)
  })
})

// ── sha256Hex ──────────────────────────────────────────────────

describe('sha256Hex', () => {
  it('matches a known vector', () => {
    // sha256('hello') as hex
    expect(sha256Hex('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })
})

// ── verifyBridgeToken ──────────────────────────────────────────

function mockDb({ row, error } = {}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve(error ? { data: null, error } : { data: row || null, error: null })),
        })),
      })),
    })),
  }
}

describe('verifyBridgeToken', () => {
  it('returns null when no Authorization header is present', async () => {
    const fakeRequest = new Request('http://localhost/api/bridge/heartbeat', { method: 'POST' })
    expect(await verifyBridgeToken(fakeRequest)).toBe(null)
  })

  it('returns null on malformed Authorization (no Bearer)', async () => {
    const fakeRequest = new Request('http://localhost/api/bridge/heartbeat', {
      method: 'POST',
      headers: { authorization: 'Basic abc123' },
    })
    expect(await verifyBridgeToken(fakeRequest)).toBe(null)
  })

  it('returns null when token lacks the bbr_ prefix', async () => {
    const fakeRequest = new Request('http://localhost/api/bridge/heartbeat', {
      method: 'POST',
      headers: { authorization: 'Bearer wrongprefix_abc' },
    })
    expect(await verifyBridgeToken(fakeRequest)).toBe(null)
  })

  it('returns null when DB returns no row for the hash', async () => {
    createServerClient.mockReturnValue(mockDb({ row: null }))
    const fakeRequest = new Request('http://localhost/api/bridge/heartbeat', {
      method: 'POST',
      headers: { authorization: 'Bearer bbr_xyz' },
    })
    expect(await verifyBridgeToken(fakeRequest)).toBe(null)
  })

  it('returns null on db error (treated as auth failure, not 500)', async () => {
    createServerClient.mockReturnValue(mockDb({ error: { message: 'rls boom' } }))
    const fakeRequest = new Request('http://localhost/api/bridge/heartbeat', {
      method: 'POST',
      headers: { authorization: 'Bearer bbr_xyz' },
    })
    expect(await verifyBridgeToken(fakeRequest)).toBe(null)
  })

  it('happy path: returns bridge identity on hash match', async () => {
    createServerClient.mockReturnValue(mockDb({
      row: {
        id: 'bridge-1',
        location_id: 'loc-1',
        hardware_id: 'pi-XYZ',
        name: 'UN1T Dublin Studio',
        status: 'online',
      },
    }))
    const fakeRequest = new Request('http://localhost/api/bridge/heartbeat', {
      method: 'POST',
      headers: { authorization: 'Bearer bbr_validtoken' },
    })
    const out = await verifyBridgeToken(fakeRequest)
    expect(out).toEqual({
      bridgeId: 'bridge-1',
      locationId: 'loc-1',
      hardwareId: 'pi-XYZ',
      name: 'UN1T Dublin Studio',
      status: 'online',
    })
  })

  it('also accepts a raw header string', async () => {
    createServerClient.mockReturnValue(mockDb({
      row: {
        id: 'bridge-1', location_id: 'loc-1', hardware_id: 'pi-1',
        name: 'b1', status: 'online',
      },
    }))
    const out = await verifyBridgeToken('Bearer bbr_validtoken')
    expect(out?.bridgeId).toBe('bridge-1')
  })

  it('also accepts a Headers object directly', async () => {
    createServerClient.mockReturnValue(mockDb({
      row: {
        id: 'bridge-1', location_id: 'loc-1', hardware_id: 'pi-1',
        name: 'b1', status: 'online',
      },
    }))
    const headers = new Headers({ authorization: 'Bearer bbr_validtoken' })
    const out = await verifyBridgeToken(headers)
    expect(out?.bridgeId).toBe('bridge-1')
  })
})
