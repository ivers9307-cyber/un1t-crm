// GLOFOXPOSTRETRY.1 — glofoxFetch retried every 429 and 5xx up to 3 times,
// whatever the method. A 5xx can come AFTER Glofox processed a write (a trial
// bought, a booking made, a member registered, a note added), so re-sending it
// did it twice. Now a 429 (refused before processing) is retried for every
// method, a 5xx only for reads (GET/HEAD, or retry: 'idempotent'), and a write
// either returns its first 5xx (retry: 'never', the default for non-GET) or
// re-sends only after a dedupe read says the first attempt did not land
// (retry: { verify }).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { logWarn } from '@/lib/log'
import {
  glofoxFetch, glofoxRetryPolicy, glofoxHttpStats, glofoxHttpStatsSince,
} from './glofox.js'

const creds = { branchId: 'br-1', apiKey: 'k', apiToken: 't' }
// Retry-After of 0.001 s keeps every backoff at 1 ms.
const res = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '0.001' : null) },
  json: async () => body,
})

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('glofoxRetryPolicy', () => {
  it('GET and HEAD retry by default; every other method never does', () => {
    expect(glofoxRetryPolicy({}).mode).toBe('idempotent')
    expect(glofoxRetryPolicy({ method: 'get' }).mode).toBe('idempotent')
    expect(glofoxRetryPolicy({ method: 'HEAD' }).mode).toBe('idempotent')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(glofoxRetryPolicy({ method }).mode).toBe('never')
    }
  })

  it('an explicit policy wins over the method', () => {
    expect(glofoxRetryPolicy({ method: 'POST', retry: 'idempotent' }).mode).toBe('idempotent')
    expect(glofoxRetryPolicy({ method: 'GET', retry: 'never' }).mode).toBe('never')
    const verify = async () => 'absent'
    expect(glofoxRetryPolicy({ method: 'POST', retry: { verify } })).toEqual({ mode: 'verify', verify })
  })

  it('an unknown policy is a programming error, thrown rather than guessed', () => {
    expect(() => glofoxRetryPolicy({ method: 'POST', retry: 'sometimes' })).toThrow(/retry policy/)
    expect(() => glofoxRetryPolicy({ method: 'POST', retry: {} })).toThrow(/retry policy/)
  })
})

describe('glofoxFetch — a write is never blindly re-sent after a 5xx', () => {
  it('a POST with no policy: the 503 comes back after ONE attempt, counted and logged once', async () => {
    fetch.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200))
    const before = glofoxHttpStats()
    const r = await glofoxFetch(creds, '/2.0/things', { method: 'POST', body: '{}' })
    expect(r.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(glofoxHttpStatsSince(before)).toMatchObject({
      requests: 1, retries: 0, status_5xx: 1, unsafe_not_retried: 1, gave_up: 0,
    })
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalledWith('glofox', 'Glofox write answered 5xx; not retried', {
      status: 503, attempts: 1, path: '/2.0/things', reason: 'never',
    })
  })

  it('a POST 429 IS retried: Glofox throttled it before processing it', async () => {
    fetch.mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200))
    const r = await glofoxFetch(creds, '/2.0/things', { method: 'POST', body: '{}' })
    expect(r.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('a GET 5xx is still retried, as before', async () => {
    fetch.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200))
    const r = await glofoxFetch(creds, '/2.0/members/abc')
    expect(r.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("retry: 'idempotent' retries a POST 5xx (a read that happens to be a POST)", async () => {
    fetch.mockResolvedValueOnce(res(502)).mockResolvedValueOnce(res(200))
    const r = await glofoxFetch(creds, '/Analytics/report', { method: 'POST', body: '{}', retry: 'idempotent' })
    expect(r.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('the retry policy is ours: it never reaches fetch', async () => {
    fetch.mockResolvedValueOnce(res(200))
    await glofoxFetch(creds, '/2.0/things', { method: 'POST', body: '{}', retry: 'never' })
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('retry')
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{}' })
  })
})

describe('glofoxFetch — a verified write re-sends only after a negative dedupe read', () => {
  it("'absent' → re-sent, and the read runs BEFORE the re-send", async () => {
    const order = []
    fetch.mockImplementation(async () => { order.push('send'); return order.length === 1 ? res(503) : res(200) })
    const verify = vi.fn(async () => { order.push('read'); return 'absent' })
    const before = glofoxHttpStats()
    const r = await glofoxFetch(creds, '/2.0/things', { method: 'POST', retry: { verify } })
    expect(r.status).toBe(200)
    expect(order).toEqual(['send', 'read', 'send'])
    expect(glofoxHttpStatsSince(before)).toMatchObject({ requests: 2, retries: 1, verify_absent: 1, unsafe_not_retried: 0 })
    expect(logWarn).not.toHaveBeenCalled()
  })

  it("'landed' → not re-sent; the 5xx comes back for the caller to read its own verdict", async () => {
    fetch.mockResolvedValue(res(503))
    const before = glofoxHttpStats()
    const r = await glofoxFetch(creds, '/2.0/things', { method: 'POST', retry: { verify: async () => 'landed' } })
    expect(r.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(glofoxHttpStatsSince(before)).toMatchObject({ requests: 1, retries: 0, verify_landed: 1, gave_up: 0 })
    expect(logWarn).toHaveBeenCalledWith('glofox', 'Glofox write answered 5xx; not retried', {
      status: 503, attempts: 1, path: '/2.0/things', reason: 'landed',
    })
  })

  it("'unknown', a throw, or a nonsense answer → not re-sent", async () => {
    for (const verify of [async () => 'unknown', async () => { throw new Error('read blew up') }, async () => 'maybe']) {
      fetch.mockReset().mockResolvedValue(res(500))
      const before = glofoxHttpStats()
      const r = await glofoxFetch(creds, '/2.0/things', { method: 'POST', retry: { verify } })
      expect(r.status).toBe(500)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(glofoxHttpStatsSince(before)).toMatchObject({ verify_unknown: 1, retries: 0 })
    }
  })

  it('a 429 on a verified write is retried WITHOUT a dedupe read (nothing was processed)', async () => {
    fetch.mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200))
    const verify = vi.fn(async () => 'absent')
    const r = await glofoxFetch(creds, '/2.0/things', { method: 'POST', retry: { verify } })
    expect(r.status).toBe(200)
    expect(verify).not.toHaveBeenCalled()
  })

  it('a write that keeps answering 5xx with absent reads stops at the retry budget (4 sends, a give-up)', async () => {
    fetch.mockResolvedValue(res(503))
    const verify = vi.fn(async () => 'absent')
    const before = glofoxHttpStats()
    const r = await glofoxFetch(creds, '/2.0/things', { method: 'POST', retry: { verify } })
    expect(r.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(verify).toHaveBeenCalledTimes(3)
    expect(glofoxHttpStatsSince(before)).toMatchObject({ requests: 4, retries: 3, verify_absent: 3, gave_up: 1 })
  })
})
