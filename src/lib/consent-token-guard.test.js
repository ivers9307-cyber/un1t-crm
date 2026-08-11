// UNSUB-RL.1 — the guard that replaced the per-IP limiter on the consent
// token endpoints.
//
// The defect it exists to remove: RFC 8058 one-click unsubscribe POSTs are
// sent by the RECIPIENT'S MAIL PROVIDER, not by the recipient. Gmail sends
// them from a shared proxy pool, so many people unsubscribing from one
// campaign arrive on one source IP. A per-IP counter therefore throttles
// *legitimate opt-outs of different people*, returns 429, and writes nothing
// — a lost withdrawal of consent that leaves no trace at all.
//
// The replacement splits the two populations the old limiter conflated:
//   • a caller presenting a token that does not resolve is enumerating, and
//     is budgeted per IP;
//   • a caller presenting a token that DOES resolve holds the credential for
//     exactly one contact, and is budgeted per TOKEN, where a shared provider
//     proxy cannot reach it.
//
// And every refusal is recorded, so "how many opt-outs did we drop" is a
// query rather than an unanswerable question.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./rate-limit.js', () => ({
  peekRateLimit: vi.fn(async () => ({ allowed: true, remaining: 5, resetAt: new Date(0), retryAfterSec: 60 })),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 5, resetAt: new Date(0), retryAfterSec: 60 })),
}))

import { peekRateLimit, checkRateLimit } from './rate-limit.js'
import {
  INVALID_TOKEN_RL,
  PER_TOKEN_RL,
  REFUSAL_REASONS,
  tokenFingerprint,
  guardBeforeTokenLookup,
  penaliseInvalidToken,
  guardResolvedToken,
  recordRefusedOptOut,
} from './consent-token-guard.js'

beforeEach(() => vi.clearAllMocks())

describe('tokenFingerprint', () => {
  it('is stable, hex, and never contains the raw token', () => {
    const fp = tokenFingerprint('9f1c7c0e-0000-4000-8000-000000000001')
    expect(fp).toMatch(/^[0-9a-f]{32}$/)
    expect(fp).toBe(tokenFingerprint('9f1c7c0e-0000-4000-8000-000000000001'))
    expect(fp).not.toContain('9f1c7c0e')
  })

  it('differs for different tokens', () => {
    expect(tokenFingerprint('a')).not.toBe(tokenFingerprint('b'))
  })

  it('returns null for a missing token rather than hashing "undefined"', () => {
    expect(tokenFingerprint(null)).toBeNull()
    expect(tokenFingerprint(undefined)).toBeNull()
    expect(tokenFingerprint('')).toBeNull()
  })
})

describe('guardBeforeTokenLookup — per-IP, invalid tokens only', () => {
  it('PEEKS the bucket, never increments it', async () => {
    await guardBeforeTokenLookup({}, 'unsubscribe', '203.0.113.9')
    expect(peekRateLimit).toHaveBeenCalledTimes(1)
    // A legitimate provider proxy must be able to POST valid tokens all day
    // without its budget moving. Only penaliseInvalidToken() increments.
    expect(checkRateLimit).not.toHaveBeenCalled()
  })

  it('keys on the scope + IP, in its own "invalid" namespace', async () => {
    await guardBeforeTokenLookup({}, 'unsubscribe', '203.0.113.9')
    expect(peekRateLimit.mock.calls[0][1]).toBe('unsubscribe:invalid:203.0.113.9')
    expect(peekRateLimit.mock.calls[0][2]).toEqual(INVALID_TOKEN_RL)
  })

  it('blocks once the invalid-token budget is spent', async () => {
    peekRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(0), retryAfterSec: 42 })
    const r = await guardBeforeTokenLookup({}, 'unsubscribe', '203.0.113.9')
    expect(r.allowed).toBe(false)
    expect(r.retryAfterSec).toBe(42)
  })
})

describe('penaliseInvalidToken', () => {
  it('increments the same bucket guardBeforeTokenLookup peeks', async () => {
    await penaliseInvalidToken({}, 'preferences', '203.0.113.9')
    expect(checkRateLimit).toHaveBeenCalledTimes(1)
    expect(checkRateLimit.mock.calls[0][1]).toBe('preferences:invalid:203.0.113.9')
    expect(checkRateLimit.mock.calls[0][2]).toEqual(INVALID_TOKEN_RL)
  })
})

describe('guardResolvedToken — per-token, never per-IP', () => {
  it('keys on the token FINGERPRINT, so the raw credential never lands in rate_limit_buckets', async () => {
    const token = '9f1c7c0e-0000-4000-8000-000000000001'
    await guardResolvedToken({}, 'unsubscribe', token)
    const key = checkRateLimit.mock.calls[0][1]
    expect(key).toBe(`unsubscribe:token:${tokenFingerprint(token)}`)
    expect(key).not.toContain(token)
  })

  it('carries no IP component at all — a shared provider proxy cannot trip it', async () => {
    await guardResolvedToken({}, 'unsubscribe', 'tok', '203.0.113.9')
    expect(checkRateLimit.mock.calls[0][1]).not.toContain('203.0.113.9')
  })

  it('is far more generous than the old per-IP limit, since one token is one person', async () => {
    expect(PER_TOKEN_RL.max).toBeGreaterThan(10)
    expect(checkRateLimit).not.toHaveBeenCalled()
  })
})

describe('recordRefusedOptOut — a dropped opt-out must leave a trace', () => {
  function mockDb() {
    const inserted = []
    return {
      inserted,
      from: () => ({ insert: (row) => { inserted.push(row); return Promise.resolve({ error: null }) } }),
    }
  }

  it('writes a row to unsubscribe_refusals', async () => {
    const db = mockDb()
    await recordRefusedOptOut(db, {
      endpoint: 'unsubscribe',
      reason: REFUSAL_REASONS.TOKEN_FLOOD,
      ip: '203.0.113.9',
      token: 'tok',
      contactId: 'c1',
      locationId: 'l1',
      campaignId: 'camp1',
      channels: ['email_marketing'],
    })
    expect(db.inserted).toHaveLength(1)
    expect(db.inserted[0]).toMatchObject({
      endpoint: 'unsubscribe',
      reason: REFUSAL_REASONS.TOKEN_FLOOD,
      contact_id: 'c1',
      location_id: 'l1',
      campaign_id: 'camp1',
      channels: ['email_marketing'],
      ip_address: '203.0.113.9',
    })
  })

  it('stores a fingerprint, never the live token', async () => {
    const db = mockDb()
    await recordRefusedOptOut(db, { endpoint: 'unsubscribe', reason: REFUSAL_REASONS.INVALID_TOKEN, token: 'sekrit-token' })
    expect(db.inserted[0].token_fingerprint).toBe(tokenFingerprint('sekrit-token'))
    expect(JSON.stringify(db.inserted[0])).not.toContain('sekrit-token')
  })

  it('never throws — a broken audit table must not also break the opt-out path', async () => {
    const throwingDb = { from: () => { throw new Error('relation does not exist') } }
    await expect(
      recordRefusedOptOut(throwingDb, { endpoint: 'unsubscribe', reason: REFUSAL_REASONS.INVALID_TOKEN }),
    ).resolves.toBeUndefined()
  })

  it('logs even when the insert fails, so the refusal is visible in runtime logs too', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failingDb = { from: () => ({ insert: async () => ({ error: { message: 'nope' } }) }) }
    await recordRefusedOptOut(failingDb, { endpoint: 'unsubscribe', reason: REFUSAL_REASONS.IP_ENUMERATION })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
