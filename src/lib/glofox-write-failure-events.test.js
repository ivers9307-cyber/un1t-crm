// GLOFOXWRITEJUDGE.1 (d) — glofoxHttpStats() counters are per instance and only
// the (read-only) crons write them down, so a request-path WRITE's 5xx / 429 /
// no-reply lived only as a log line Vercel keeps for 24 h. Now each such write
// call leaves ONE error_events row (route_type 'glofox_write', no ids). Reads
// never do: the crons already record theirs, and a Glofox outage would turn a
// read fan-out into an alert storm.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/error-events', () => ({ recordErrorEvent: vi.fn(async () => {}) }))

import { recordErrorEvent } from '@/lib/error-events'
import { glofoxFetch, isGlofoxWrite, glofoxWriteFailureEvent, searchGlofoxMember } from './glofox.js'

const creds = { branchId: 'br-1', apiKey: 'k', apiToken: 't' }
const ID = 'a'.repeat(24)
const res = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '0.001' : null) },
  json: async () => body,
  clone() { return { json: async () => body } },
})
const post = (retry) => ({ method: 'POST', body: '{}', ...(retry ? { retry } : {}) })

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('isGlofoxWrite', () => {
  it('a non-GET that is not a read-POST is a write', () => {
    expect(isGlofoxWrite({ method: 'POST' })).toBe(true)
    expect(isGlofoxWrite({ method: 'PUT', retry: 'never' })).toBe(true)
    expect(isGlofoxWrite({ method: 'POST', retry: { verify: async () => 'absent' } })).toBe(true)
  })
  it('GET/HEAD, read-POSTs (retry idempotent) and readOnly calls are not', () => {
    expect(isGlofoxWrite({})).toBe(false)
    expect(isGlofoxWrite({ method: 'GET', retry: 'never' })).toBe(false) // a one-attempt dedupe read
    expect(isGlofoxWrite({ method: 'POST', retry: 'idempotent' })).toBe(false)
    expect(isGlofoxWrite({ method: 'POST', retry: 'never', readOnly: true })).toBe(false)
  })
})

describe('glofoxWriteFailureEvent', () => {
  it('names the write without ids and without an em-dash', () => {
    const row = glofoxWriteFailureEvent({
      method: 'post', pathOrUrl: `/2.2/branches/br-1/users/${ID}/memberships/${ID}/plans/123456/purchase?x=${ID}`,
      status: 503, attempts: 1, reason: 'never',
    })
    expect(row).toMatchObject({
      route_type: 'glofox_write', method: 'POST', name: 'glofox_write_5xx', digest: null, vercel_id: null,
      route_path: 'glofox:POST /2.2/branches/br-1/users/:id/memberships/:id/plans/:id/purchase',
    })
    expect(row.message).toMatch(/answered HTTP 503 after 1 attempt/)
    expect(row.message).toMatch(/not re-sent/)
    expect(JSON.stringify(row)).not.toContain(ID)
    expect(row.message).not.toMatch(/—/)
  })
  it('429 and no-reply get their own names', () => {
    expect(glofoxWriteFailureEvent({ method: 'POST', pathOrUrl: '/2.0/bookings', status: 429, attempts: 4, reason: 'gave_up' }).name).toBe('glofox_write_429')
    const nr = glofoxWriteFailureEvent({ method: 'POST', pathOrUrl: '/2.0/bookings', status: 0, attempts: 1, reason: 'no_reply' })
    expect(nr.name).toBe('glofox_write_no_reply')
    expect(nr.message).toMatch(/no reply/)
  })
})

describe('glofoxFetch records a failed write once', () => {
  it('a POST 503 not re-sent (never) → one row, and the 503 still comes back', async () => {
    fetch.mockResolvedValueOnce(res(503))
    const r = await glofoxFetch(creds, '/2.0/bookings', post())
    expect(r.status).toBe(503)
    expect(recordErrorEvent).toHaveBeenCalledTimes(1)
    expect(recordErrorEvent.mock.calls[0][0]).toMatchObject({ name: 'glofox_write_5xx', route_path: 'glofox:POST /2.0/bookings' })
    expect(recordErrorEvent.mock.calls[0][0].message).toMatch(/Glofox may already have done it/)
  })

  it('a POST 429 on every attempt → one row named glofox_write_429 (gave up)', async () => {
    fetch.mockResolvedValue(res(429))
    const r = await glofoxFetch(creds, '/2.0/bookings', post())
    expect(r.status).toBe(429)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(recordErrorEvent).toHaveBeenCalledTimes(1)
    expect(recordErrorEvent.mock.calls[0][0]).toMatchObject({ name: 'glofox_write_429' })
    expect(recordErrorEvent.mock.calls[0][0].message).toMatch(/after 4 attempt/)
  })

  it('a verified write whose dedupe read found it landed → one row (reason landed)', async () => {
    fetch.mockResolvedValueOnce(res(503))
    await glofoxFetch(creds, '/2.0/bookings', post({ verify: async () => 'landed' }))
    expect(recordErrorEvent).toHaveBeenCalledTimes(1)
    expect(recordErrorEvent.mock.calls[0][0].message).toMatch(/found it had gone through/)
  })

  it('a POST that throws (no reply) → one row, and the error is still thrown', async () => {
    fetch.mockRejectedValueOnce(new Error('socket hang up'))
    await expect(glofoxFetch(creds, '/2.0/register', post({ verify: async () => 'absent' }))).rejects.toThrow('socket hang up')
    expect(recordErrorEvent).toHaveBeenCalledTimes(1)
    expect(recordErrorEvent.mock.calls[0][0]).toMatchObject({ name: 'glofox_write_no_reply', route_path: 'glofox:POST /2.0/register' })
  })

  it('a write that recovers (429 then 200, or 503 → absent → 200) leaves NO row', async () => {
    fetch.mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200))
    await glofoxFetch(creds, '/2.0/bookings', post())
    fetch.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200))
    await glofoxFetch(creds, '/2.0/bookings', post({ verify: async () => 'absent' }))
    expect(recordErrorEvent).not.toHaveBeenCalled()
  })

  it('reads never leave a row: a GET, a read-POST, and a one-attempt dedupe read', async () => {
    fetch.mockResolvedValue(res(500))
    await glofoxFetch(creds, '/2.0/members/x')
    await glofoxFetch(creds, '/Analytics/report', { method: 'POST', body: '{}', retry: 'idempotent' })
    await glofoxFetch(creds, '/2.0/bookings?user_id=x', { retry: 'never' })
    expect(recordErrorEvent).not.toHaveBeenCalled()
  })

  it('the v3 member search, sent once as a write\'s dedupe read, is a read (readOnly)', async () => {
    fetch.mockResolvedValue(res(500))
    await searchGlofoxMember(creds, { email: 'sam@x.com', retry: 'never' })
    expect(recordErrorEvent).not.toHaveBeenCalled()
  })

  it('a recorder that throws never changes the answer', async () => {
    recordErrorEvent.mockRejectedValueOnce(new Error('db down'))
    fetch.mockResolvedValueOnce(res(503))
    const r = await glofoxFetch(creds, '/2.0/bookings', post())
    expect(r.status).toBe(503)
  })

  it('`readOnly` never reaches fetch', async () => {
    fetch.mockResolvedValueOnce(res(200))
    await glofoxFetch(creds, '/v3.0/namespaces/members/retrieve', { method: 'POST', body: '{}', retry: 'never', readOnly: true })
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('readOnly')
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('retry')
  })
})
