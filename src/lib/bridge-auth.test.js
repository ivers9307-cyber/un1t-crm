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

// The lookup is now `.from().select().or().maybeSingle()` (matches either the
// current OR the previous/grace token hash).
function mockDb({ row, error } = {}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        or: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve(error ? { data: null, error } : { data: row || null, error: null })),
        })),
      })),
    })),
  }
}

// Convenience: build a full ble_bridges row whose current-token hash matches
// the given raw token, so verifyBridgeToken sees a current-token match.
function bridgeRow(rawToken, overrides = {}) {
  return {
    id: 'bridge-1',
    location_id: 'loc-1',
    hardware_id: 'pi-1',
    name: 'b1',
    status: 'online',
    api_token_hash: sha256Hex(rawToken),
    previous_token_hash: null,
    previous_token_expires_at: null,
    ...overrides,
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

  it('happy path: returns bridge identity on current-token hash match', async () => {
    createServerClient.mockReturnValue(mockDb({
      row: bridgeRow('bbr_validtoken', {
        hardware_id: 'pi-XYZ',
        name: 'UN1T Dublin Studio',
      }),
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
    createServerClient.mockReturnValue(mockDb({ row: bridgeRow('bbr_validtoken') }))
    const out = await verifyBridgeToken('Bearer bbr_validtoken')
    expect(out?.bridgeId).toBe('bridge-1')
  })

  it('also accepts a Headers object directly', async () => {
    createServerClient.mockReturnValue(mockDb({ row: bridgeRow('bbr_validtoken') }))
    const headers = new Headers({ authorization: 'Bearer bbr_validtoken' })
    const out = await verifyBridgeToken(headers)
    expect(out?.bridgeId).toBe('bridge-1')
  })

  // ── grace-window (rotated / previous) token ────────────────────

  it('accepts a rotated (previous) token while within the grace window', async () => {
    // Row's CURRENT hash is a different token; the request presents the OLD
    // token, which the DB matched via previous_token_hash. Grace not expired.
    const row = bridgeRow('bbr_newtoken', {
      previous_token_hash: sha256Hex('bbr_oldtoken'),
      previous_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    createServerClient.mockReturnValue(mockDb({ row }))
    const out = await verifyBridgeToken('Bearer bbr_oldtoken')
    expect(out?.bridgeId).toBe('bridge-1')
  })

  it('rejects a rotated (previous) token after the grace window has expired', async () => {
    const row = bridgeRow('bbr_newtoken', {
      previous_token_hash: sha256Hex('bbr_oldtoken'),
      previous_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
    })
    createServerClient.mockReturnValue(mockDb({ row }))
    const out = await verifyBridgeToken('Bearer bbr_oldtoken')
    expect(out).toBe(null)
  })

  it('rejects a previous-token match with a null expiry (no active grace)', async () => {
    const row = bridgeRow('bbr_newtoken', {
      previous_token_hash: sha256Hex('bbr_oldtoken'),
      previous_token_expires_at: null,
    })
    createServerClient.mockReturnValue(mockDb({ row }))
    const out = await verifyBridgeToken('Bearer bbr_oldtoken')
    expect(out).toBe(null)
  })

  it('still accepts the CURRENT token even while a grace window is active', async () => {
    const row = bridgeRow('bbr_newtoken', {
      previous_token_hash: sha256Hex('bbr_oldtoken'),
      previous_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    createServerClient.mockReturnValue(mockDb({ row }))
    const out = await verifyBridgeToken('Bearer bbr_newtoken')
    expect(out?.bridgeId).toBe('bridge-1')
  })

  // ── decommissioned status ──────────────────────────────────────

  it('rejects a decommissioned bridge even with a correct current token', async () => {
    const row = bridgeRow('bbr_validtoken', { status: 'decommissioned' })
    createServerClient.mockReturnValue(mockDb({ row }))
    const out = await verifyBridgeToken('Bearer bbr_validtoken')
    expect(out).toBe(null)
  })

  it('rejects a decommissioned bridge presenting a still-in-grace previous token', async () => {
    const row = bridgeRow('bbr_newtoken', {
      status: 'decommissioned',
      previous_token_hash: sha256Hex('bbr_oldtoken'),
      previous_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    createServerClient.mockReturnValue(mockDb({ row }))
    const out = await verifyBridgeToken('Bearer bbr_oldtoken')
    expect(out).toBe(null)
  })

  it('offline and error bridges still authenticate (liveness, not a block)', async () => {
    for (const status of ['offline', 'error']) {
      createServerClient.mockReturnValue(mockDb({ row: bridgeRow('bbr_validtoken', { status }) }))
      const out = await verifyBridgeToken('Bearer bbr_validtoken')
      expect(out?.status).toBe(status)
    }
  })
})
