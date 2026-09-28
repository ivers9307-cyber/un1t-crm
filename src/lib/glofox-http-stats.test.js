// CREDITSREAD.1 — glofoxFetch retried 429/5xx and logged nothing, so our
// Glofox headroom was unmeasurable. It now counts every attempt, 429, 5xx,
// retry, network error and give-up, and logs one structured line (no ids) when
// a call is still failing after its retries.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { logWarn } from '@/lib/log'
import { glofoxFetch, glofoxHttpStats, glofoxHttpStatsSince, glofoxPathLabel, fetchMembershipResult } from './glofox.js'

const creds = { branchId: 'br-1', apiKey: 'k', apiToken: 't' }
// Retry-After of 0.001 s keeps each backoff at 1 ms.
const res = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '0.001' : null) },
  json: async () => body,
})

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('glofoxPathLabel', () => {
  it('drops the query and replaces ids, so a log line never carries a member id', () => {
    expect(glofoxPathLabel('/2.0/members/0000000000000000000000b2')).toBe('/2.0/members/:id')
    expect(glofoxPathLabel('/2.0/credits?user_id=0000000000000000000000b2')).toBe('/2.0/credits')
    expect(glofoxPathLabel('https://gf-api.aws.glofox.com/prod/2.0/memberships/0000000000000000000000f1?x=1'))
      .toBe('/prod/2.0/memberships/:id')
    expect(glofoxPathLabel('/2.0/branches/1234567/events')).toBe('/2.0/branches/:id/events')
    expect(glofoxPathLabel('/2.0/members')).toBe('/2.0/members')
  })

  it('replaces a UUID segment too', () => {
    expect(glofoxPathLabel('/v3.0/payment-links/invoices/0a1b2c3d-0000-4000-8000-00000000abcd'))
      .toBe('/v3.0/payment-links/invoices/:id')
    expect(glofoxPathLabel('/v3.0/payment-links/invoices/0A1B2C3D-0000-4000-8000-00000000ABCD/pay'))
      .toBe('/v3.0/payment-links/invoices/:id/pay')
  })
})

describe('glofoxFetch counters', () => {
  it('a 429 then a 200: two requests, one 429, one retry, no give-up, no log', async () => {
    fetch.mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200, { data: [] }))
    const before = glofoxHttpStats()
    const r = await glofoxFetch(creds, '/2.0/credits?user_id=abc')
    expect(r.status).toBe(200)
    expect(glofoxHttpStatsSince(before)).toEqual({
      requests: 2, retries: 1, status_429: 1, status_5xx: 0, network_errors: 0, gave_up: 0, aborted: 0,
    })
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('a 503 that never recovers: four requests, three retries, one give-up, one structured warning', async () => {
    fetch.mockResolvedValue(res(503))
    const before = glofoxHttpStats()
    const r = await glofoxFetch(creds, '/2.0/members/0000000000000000000000b2')
    expect(r.status).toBe(503)
    expect(glofoxHttpStatsSince(before)).toEqual({
      requests: 4, retries: 3, status_429: 0, status_5xx: 4, network_errors: 0, gave_up: 1, aborted: 0,
    })
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalledWith('glofox', 'Glofox still failing after retries', {
      status: 503, attempts: 4, path: '/2.0/members/:id',
    })
  })

  it('a 404 is an answer: one request, nothing else counted, no log', async () => {
    fetch.mockResolvedValueOnce(res(404))
    const before = glofoxHttpStats()
    await glofoxFetch(creds, '/2.0/members/abc')
    expect(glofoxHttpStatsSince(before)).toEqual({
      requests: 1, retries: 0, status_429: 0, status_5xx: 0, network_errors: 0, gave_up: 0, aborted: 0,
    })
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('a call cancelled mid-retry is counted as aborted, not as still failing after retries', async () => {
    fetch.mockResolvedValue(res(503))
    const ctrl = new AbortController()
    ctrl.abort()
    const before = glofoxHttpStats()
    const r = await glofoxFetch(creds, '/2.0/members/0000000000000000000000b2', { signal: ctrl.signal })
    expect(r.status).toBe(503)
    expect(glofoxHttpStatsSince(before)).toEqual({
      requests: 1, retries: 0, status_429: 0, status_5xx: 1, network_errors: 0, gave_up: 0, aborted: 1,
    })
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('a network error is counted and still thrown (callers already catch it)', async () => {
    fetch.mockRejectedValueOnce(new TypeError('fetch failed'))
    const before = glofoxHttpStats()
    await expect(glofoxFetch(creds, '/2.0/members/abc')).rejects.toThrow('fetch failed')
    expect(glofoxHttpStatsSince(before)).toMatchObject({ requests: 1, network_errors: 1, gave_up: 0 })
  })

  it('glofoxHttpStats is a copy: changing it changes nothing', async () => {
    const snap = glofoxHttpStats()
    snap.requests = -99
    expect(glofoxHttpStats().requests).not.toBe(-99)
  })
})

describe('fetchMembershipResult', () => {
  it('a failed read (5xx after retries) is ok:false and NOT cached, so the next member in the run asks again', async () => {
    for (let i = 0; i < 4; i++) fetch.mockResolvedValueOnce(res(500))
    const cache = new Map()
    expect(await fetchMembershipResult(creds, 'mem-1', cache)).toEqual({ ok: false, membership: null })
    expect(cache.has('mem-1')).toBe(false)

    fetch.mockResolvedValueOnce(res(200, { _id: 'mem-1', trial: false, plans: [{ type: 'num_classes' }] }))
    const r = await fetchMembershipResult(creds, 'mem-1', cache)
    expect(r).toEqual({ ok: true, membership: { _id: 'mem-1', trial: false, plans: [{ type: 'num_classes' }] } })
    expect(cache.get('mem-1')).toEqual(r.membership)

    // served from the cache: no further call
    expect(await fetchMembershipResult(creds, 'mem-1', cache)).toEqual(r)
    expect(fetch).toHaveBeenCalledTimes(5)
  })

  it('a 404 is an answer ("no such membership"): ok:true, null, and cached', async () => {
    fetch.mockResolvedValueOnce(res(404))
    const cache = new Map()
    expect(await fetchMembershipResult(creds, 'mem-3', cache)).toEqual({ ok: true, membership: null })
    expect(cache.has('mem-3')).toBe(true)
    expect(await fetchMembershipResult(creds, 'mem-3', cache)).toEqual({ ok: true, membership: null })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('a 429 after retries is a failure, not cached', async () => {
    fetch.mockResolvedValue(res(429))
    const cache = new Map()
    expect(await fetchMembershipResult(creds, 'mem-4', cache)).toEqual({ ok: false, membership: null })
    expect(cache.has('mem-4')).toBe(false)
  })

  it('a thrown fetch is ok:false, not cached', async () => {
    fetch.mockRejectedValueOnce(new TypeError('fetch failed'))
    const cache = new Map()
    expect(await fetchMembershipResult(creds, 'mem-2', cache)).toEqual({ ok: false, membership: null })
    expect(cache.size).toBe(0)
  })
})
