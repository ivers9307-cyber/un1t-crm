import { describe, it, expect, vi } from 'vitest'
import { getClientIp, checkRateLimit, rateLimitResponse } from './rate-limit.js'

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
