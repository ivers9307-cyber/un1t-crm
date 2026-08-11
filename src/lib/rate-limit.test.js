import { describe, it, expect, vi } from 'vitest'
import { getClientIp, checkRateLimit, peekRateLimit, rateLimitResponse } from './rate-limit.js'

describe('getClientIp', () => {
  it('returns the first IP from x-forwarded-for', () => {
    const req = { headers: new Map([['x-forwarded-for', '1.2.3.4, 5.6.7.8']]) }
    req.headers.get = (k) => req.headers.get.call(Map.prototype, k) ?? null
    // Use a real Headers-like
    const r2 = { headers: { get: (k) => k === 'x-forwarded-for' ? '1.2.3.4, 5.6.7.8' : null } }
    expect(getClientIp(r2)).toBe('1.2.3.4')
  })

  it('falls back to x-real-ip', () => {
    const req = { headers: { get: (k) => k === 'x-real-ip' ? '9.9.9.9' : null } }
    expect(getClientIp(req)).toBe('9.9.9.9')
  })

  it('returns "unknown" when no IP header is present', () => {
    const req = { headers: { get: () => null } }
    expect(getClientIp(req)).toBe('unknown')
  })

  it('trims whitespace around the first IP', () => {
    const req = { headers: { get: (k) => k === 'x-forwarded-for' ? '  1.2.3.4  ' : null } }
    expect(getClientIp(req)).toBe('1.2.3.4')
  })
})

describe('checkRateLimit', () => {
  function mockDb(rpcImpl) {
    return { rpc: vi.fn(rpcImpl) }
  }

  it('allows when count <= max', async () => {
    const db = mockDb(async () => ({ data: 3, error: null }))
    const r = await checkRateLimit(db, 'k', { max: 5, windowMs: 60_000 })
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(2)
  })

  it('rejects when count > max', async () => {
    const db = mockDb(async () => ({ data: 6, error: null }))
    const r = await checkRateLimit(db, 'k', { max: 5, windowMs: 60_000 })
    expect(r.allowed).toBe(false)
    expect(r.remaining).toBe(0)
  })

  it('fails OPEN if the RPC errors (limiter never blocks legit traffic on infra issues)', async () => {
    const db = mockDb(async () => ({ data: null, error: { message: 'connection refused' } }))
    const r = await checkRateLimit(db, 'k', { max: 5, windowMs: 60_000 })
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(5)
  })

  it('fails OPEN if the RPC throws', async () => {
    const db = mockDb(() => { throw new Error('network down') })
    const r = await checkRateLimit(db, 'k', { max: 5, windowMs: 60_000 })
    expect(r.allowed).toBe(true)
  })

  it('returns retryAfterSec >= 1', async () => {
    const db = mockDb(async () => ({ data: 100, error: null }))
    const r = await checkRateLimit(db, 'k', { max: 5, windowMs: 60_000 })
    expect(r.retryAfterSec).toBeGreaterThanOrEqual(1)
  })
})

// UNSUB-RL.1 — peekRateLimit reads a bucket WITHOUT spending from it.
//
// Needed by the consent token endpoints, where the budget must only be
// consumed by callers that presented a token which did not resolve. Reading
// and spending have to be separable for that, because the read happens before
// we know which population the caller is in.
describe('peekRateLimit', () => {
  function mockDb(row, error = null) {
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => ({ data: row, error })),
    }
    return { from: vi.fn(() => chain), chain }
  }

  it('allows when no bucket row exists yet', async () => {
    const db = mockDb(null)
    const r = await peekRateLimit(db, 'k', { max: 5, windowMs: 60_000 })
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(5)
  })

  it('allows while count is at or under max', async () => {
    const db = mockDb({ count: 5 })
    const r = await peekRateLimit(db, 'k', { max: 5, windowMs: 60_000 })
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(0)
  })

  it('blocks once count has passed max', async () => {
    const db = mockDb({ count: 6 })
    const r = await peekRateLimit(db, 'k', { max: 5, windowMs: 60_000 })
    expect(r.allowed).toBe(false)
  })

  it('does NOT increment — it must never call the rate_limit_hit RPC', async () => {
    const db = mockDb({ count: 1 })
    db.rpc = vi.fn()
    await peekRateLimit(db, 'k', { max: 5, windowMs: 60_000 })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('fails OPEN when the read errors', async () => {
    const db = mockDb(null, { message: 'boom' })
    const r = await peekRateLimit(db, 'k', { max: 5, windowMs: 60_000 })
    expect(r.allowed).toBe(true)
  })

  it('fails OPEN when the read throws', async () => {
    const db = { from: () => { throw new Error('network down') } }
    const r = await peekRateLimit(db, 'k', { max: 5, windowMs: 60_000 })
    expect(r.allowed).toBe(true)
  })

  it('reads the same window boundary checkRateLimit writes', async () => {
    const db = mockDb({ count: 1 })
    const windowMs = 60_000
    await peekRateLimit(db, 'k', { max: 5, windowMs })
    const expected = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString()
    expect(db.chain.eq).toHaveBeenCalledWith('window_start', expected)
  })
})

describe('rateLimitResponse', () => {
  it('returns 429 with Retry-After header', async () => {
    const result = { allowed: false, remaining: 0, resetAt: new Date(Date.now() + 60_000), retryAfterSec: 60 }
    const res = rateLimitResponse(result)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0')
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/Too many/)
  })
})
