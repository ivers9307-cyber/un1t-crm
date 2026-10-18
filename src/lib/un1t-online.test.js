// Tests for the GET-only un1t.online client (UN1TSYNC.2). A fake fetch only:
// nothing here reaches the real api.un1t.online.

import { describe, it, expect, vi } from 'vitest'
import { createUn1tClient, Un1tAuthError, Un1tApiError, headerNumber, resetWaitMs } from './un1t-online'
import { logWarn } from './log'

vi.mock('./log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

function res(status, body, headers = {}) {
  return { status, headers: new Headers(headers), json: async () => body }
}

function page(rows, p, pages, total, headers) {
  return res(200, { success: true, pagination: { total, page: p, pages, pageSize: 100 }, data: rows }, headers)
}

function rowsOf(from, to) {
  const out = []
  for (let i = from; i <= to; i++) out.push({ id: `r${i}` })
  return out
}

// A fetch that serves a queue of responses and records every call.
function fakeFetch(queue) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, ...init })
    const next = queue.shift()
    if (!next) throw new Error('fakeFetch: queue empty')
    return typeof next === 'function' ? next(url, init) : next
  }
  fn.calls = calls
  return fn
}

function setup(queue, opts = {}) {
  const fetchImpl = fakeFetch(queue)
  const sleeps = []
  const sleep = async (ms) => { sleeps.push(ms) }
  const client = createUn1tClient({ token: 't', fetchImpl, sleep, ...opts })
  return { client, fetchImpl, sleeps }
}

describe('createUn1tClient', () => {
  it('issues only GET', async () => {
    const self = { id: 's', name: 'n', studio: { id: 'st' }, permissions: [], allowed_origins: [], expires_at: 'x' }
    const { client, fetchImpl } = setup([res(200, { success: true, data: self }), page([{ id: 'a' }], 1, 1, 1)])
    await client.getSelf()
    await client.listAll('/bookings')
    expect(fetchImpl.calls.length).toBe(2)
    for (const c of fetchImpl.calls) expect(c.method).toBe('GET')
    expect(Object.keys(createUn1tClient({ token: 't' }))).toEqual(['getSelf', 'listAll', 'getOne', 'stats'])
  })

  it('getSelf returns the data of GET /api-token', async () => {
    const self = { id: 's', studio: { id: 'st', title: 'Hatch' } }
    const { client, fetchImpl } = setup([res(200, { success: true, data: self })])
    await expect(client.getSelf()).resolves.toEqual(self)
    expect(fetchImpl.calls[0].url).toBe('https://api.un1t.online/api-token')
  })

  it('sends the bearer token', async () => {
    const { client, fetchImpl } = setup([page([], 1, 1, 0)])
    await client.listAll('/bookings')
    expect(fetchImpl.calls[0].headers.Authorization).toBe('Bearer t')
  })

  it('walks every page at pageSize 100', async () => {
    const { client, fetchImpl } = setup([
      page(rowsOf(1, 100), 1, 2, 182),
      page(rowsOf(101, 182), 2, 2, 182),
    ])
    const out = await client.listAll('/bookings')
    expect(out.rows.length).toBe(182)
    expect(out.total).toBe(182)
    expect(out.truncated).toBe(false)
    expect(fetchImpl.calls[0].url.endsWith('?page=1&pageSize=100')).toBe(true)
    expect(fetchImpl.calls[1].url.endsWith('?page=2&pageSize=100')).toBe(true)
  })

  it('appends with & when the path already has a query string', async () => {
    const { client, fetchImpl } = setup([page([], 1, 1, 0)])
    await client.listAll('/bookings?status=open')
    expect(fetchImpl.calls[0].url).toBe('https://api.un1t.online/bookings?status=open&page=1&pageSize=100')
  })

  it('dedupes rows by id across pages', async () => {
    const { client } = setup([
      page(rowsOf(1, 100), 1, 2, 101),
      page([{ id: 'r100' }, { id: 'r101' }], 2, 2, 101),
    ])
    const out = await client.listAll('/bookings')
    expect(out.rows.length).toBe(101)
    expect(new Set(out.rows.map((r) => r.id)).size).toBe(101)
  })

  it('stops at maxPages and flags truncated', async () => {
    const { client, fetchImpl } = setup([
      page(rowsOf(1, 100), 1, 5, 500),
      page(rowsOf(101, 200), 2, 5, 500),
    ], { maxPages: 2 })
    const out = await client.listAll('/bookings')
    expect(out.truncated).toBe(true)
    expect(out.rows.length).toBe(200)
    expect(fetchImpl.calls.length).toBe(2)
  })

  it('waits for the window when remaining hits 0', async () => {
    const { client, sleeps } = setup([
      page(rowsOf(1, 100), 1, 2, 150, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '7' }),
      page(rowsOf(101, 150), 2, 2, 150, { 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '60' }),
    ])
    await client.listAll('/bookings')
    expect(sleeps).toEqual([8000])
    expect(client.stats().waitedMs).toBe(8000)
  })

  it('retries a 429 after the reset', async () => {
    const { client, sleeps } = setup([
      res(429, { success: false }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '7' }),
      page([{ id: 'a' }], 1, 1, 1),
    ])
    const out = await client.listAll('/bookings')
    expect(out.rows.length).toBe(1)
    expect(sleeps).toEqual([8000])
    expect(client.stats().retries).toBe(1)
  })

  it('honours Retry-After when present', async () => {
    const { client, sleeps } = setup([
      res(429, {}, { 'retry-after': '3' }),
      page([], 1, 1, 0),
    ])
    await client.listAll('/bookings')
    expect(sleeps).toEqual([3000])
  })

  it('refuses a Retry-After longer than 90s instead of sleeping, and allows exactly 90s', async () => {
    const long = setup([res(429, {}, { 'retry-after': '91' })])
    const err = await long.client.listAll('/bookings').catch((e) => e)
    expect(err).toBeInstanceOf(Un1tApiError)
    expect(err).toMatchObject({ status: 429, code: 'wait_too_long' })
    expect(long.sleeps).toEqual([])
    expect(long.fetchImpl.calls.length).toBe(1)

    const edge = setup([res(429, {}, { 'retry-after': '90' }), page([], 1, 1, 0)])
    await edge.client.listAll('/bookings')
    expect(edge.sleeps).toEqual([90000])
  })

  it('refuses a rate-limit reset longer than 90s, on a 429 and on a spent window', async () => {
    const onRetry = setup([res(503, {}, { 'x-ratelimit-reset': '600' })])
    const e1 = await onRetry.client.listAll('/bookings').catch((e) => e)
    expect(e1).toMatchObject({ status: 503, code: 'wait_too_long' })
    expect(onRetry.sleeps).toEqual([])

    const spent = setup([page(rowsOf(1, 100), 1, 2, 150, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '600' })])
    const e2 = await spent.client.listAll('/bookings').catch((e) => e)
    expect(e2).toMatchObject({ status: 429, code: 'wait_too_long' })
    expect(spent.sleeps).toEqual([])
  })

  it('backs off exponentially on a 5xx with no rate-limit headers', async () => {
    const { client, sleeps } = setup([res(503, {}), res(503, {}), page([], 1, 1, 0)])
    await client.listAll('/bookings')
    expect(sleeps).toEqual([1000, 2000])
  })

  it('gives up after 3 retries on 429 or 5xx', async () => {
    const { client, fetchImpl } = setup([res(503, {}), res(503, {}), res(503, {}), res(503, {})])
    const err = await client.listAll('/bookings').catch((e) => e)
    expect(err).toBeInstanceOf(Un1tApiError)
    expect(err.status).toBe(503)
    expect(fetchImpl.calls.length).toBe(4)
    expect(client.stats().retries).toBe(3)
  })

  it('401 is Un1tAuthError with no retry', async () => {
    const { client, fetchImpl } = setup([res(401, { success: false })])
    const err = await client.getSelf().catch((e) => e)
    expect(err).toBeInstanceOf(Un1tAuthError)
    expect(err.status).toBe(401)
    expect(fetchImpl.calls.length).toBe(1)
  })

  it('403 is Un1tAuthError too', async () => {
    const { client } = setup([res(403, {})])
    await expect(client.getSelf()).rejects.toBeInstanceOf(Un1tAuthError)
  })

  it('a 404 is Un1tApiError with no retry', async () => {
    const { client, fetchImpl } = setup([res(404, {})])
    const err = await client.listAll('/nope').catch((e) => e)
    expect(err).toBeInstanceOf(Un1tApiError)
    expect(err.status).toBe(404)
    expect(fetchImpl.calls.length).toBe(1)
  })

  it('success:false body is Un1tApiError', async () => {
    const { client } = setup([res(200, { success: false, error: { status: 400, message: 'x' } })])
    const err = await client.getSelf().catch((e) => e)
    expect(err).toBeInstanceOf(Un1tApiError)
    expect(err.code).toBe(400)
  })

  it('unreadable JSON is Un1tApiError', async () => {
    const bad = { status: 200, headers: new Headers(), json: async () => { throw new SyntaxError('bad') } }
    const { client } = setup([bad])
    await expect(client.getSelf()).rejects.toBeInstanceOf(Un1tApiError)
  })

  it('gives up after 3 retries on a 429 that never clears, with the rate-limit wait each time', async () => {
    const limited = () => res(429, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2' })
    const { client, fetchImpl, sleeps } = setup([limited(), limited(), limited(), limited()])
    const err = await client.listAll('/bookings').catch((e) => e)
    expect(err).toBeInstanceOf(Un1tApiError)
    expect(err.status).toBe(429)
    expect(err.message).toMatch(/HTTP 429 after 3 retries/)
    expect(fetchImpl.calls.length).toBe(4)
    expect(sleeps).toEqual([3000, 3000, 3000])
    expect(client.stats()).toMatchObject({ requests: 4, retries: 3, waitedMs: 9000 })
  })

  it('retries a network fault with backoff, and recovers', async () => {
    const boom = () => { throw new TypeError('fetch failed') }
    const { client, fetchImpl, sleeps } = setup([boom, boom, page([{ id: 'r1' }], 1, 1, 1)])
    const { rows } = await client.listAll('/bookings')
    expect(rows).toEqual([{ id: 'r1' }])
    expect(fetchImpl.calls.length).toBe(3)
    expect(sleeps).toEqual([1000, 2000])
    expect(client.stats().retries).toBe(2)
  })

  it('a network fault that never clears is Un1tApiError status 0 after 3 retries', async () => {
    const boom = () => { throw new TypeError('fetch failed') }
    const { client, fetchImpl } = setup([boom, boom, boom, boom])
    const err = await client.getSelf().catch((e) => e)
    expect(err).toBeInstanceOf(Un1tApiError)
    expect(err.status).toBe(0)
    expect(fetchImpl.calls.length).toBe(4)
  })

  it('never puts a realistic token in any error, on any failure path, or in any warning log', async () => {
    const TOKEN = 'un1t_' + 'A1b2C3d4'.repeat(6)
    const boom = () => { throw new TypeError(`fetch failed`) }
    const paths = [
      [res(401, { success: false })],
      [res(403, {})],
      [res(404, { success: false, error: { message: 'not found' } })],
      [res(200, { success: false, error: { status: 400, message: 'bad' } })],
      [{ status: 200, headers: new Headers(), json: async () => { throw new SyntaxError('bad') } }],
      [res(503, {}), res(503, {}), res(503, {}), res(503, {})],
      [boom, boom, boom, boom],
    ]
    for (const queue of paths) {
      vi.mocked(logWarn).mockClear()
      const fetchImpl = fakeFetch(queue)
      const client = createUn1tClient({ token: TOKEN, fetchImpl, sleep: async () => {} })
      const err = await client.getSelf().catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      // The token really was sent, so its absence below means something.
      expect(fetchImpl.calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`)
      const surfaced = JSON.stringify({ message: err.message, name: err.name, status: err.status, code: err.code, stack: err.stack })
      expect(surfaced).not.toContain(TOKEN)
      expect(surfaced).not.toContain('Bearer')
      expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toContain(TOKEN)
    }
  })

  it('never puts the token in an error message', async () => {
    const { client } = setup([res(401, {})])
    const err = await client.getSelf().catch((e) => e)
    expect(err.message).not.toContain('Bearer')
  })

  it('getOne returns body.data of one GET and never pages', async () => {
    const booking = { id: 'bk1', event_id: 'ev1' }
    const { client, fetchImpl } = setup([res(200, { success: true, data: booking })])
    await expect(client.getOne('/bookings/bk1')).resolves.toEqual(booking)
    expect(fetchImpl.calls.length).toBe(1)
    expect(fetchImpl.calls[0].method).toBe('GET')
    expect(fetchImpl.calls[0].url).toBe('https://api.un1t.online/bookings/bk1')
    expect(fetchImpl.calls[0].url).not.toContain('page=')
  })

  it('beforeRequest runs once before every HTTP request, retries included', async () => {
    const beforeRequest = vi.fn(async () => {})
    const { client, fetchImpl } = setup([
      res(503, {}),
      res(200, { success: true, data: { id: 's' } }),
    ], { beforeRequest })
    await client.getSelf()
    expect(fetchImpl.calls.length).toBe(2)
    expect(beforeRequest).toHaveBeenCalledTimes(2)
  })

  it('a beforeRequest that throws stops the request and surfaces the error', async () => {
    const boom = new Error('budget spent')
    const beforeRequest = vi.fn(async () => { throw boom })
    const { client, fetchImpl } = setup([res(200, { success: true, data: {} })], { beforeRequest })
    await expect(client.getSelf()).rejects.toBe(boom)
    await expect(client.getOne('/bookings/bk1')).rejects.toBe(boom)
    expect(fetchImpl.calls.length).toBe(0)
  })

  it('exports the rate-limit header helpers', () => {
    const h = new Headers({ 'x-ratelimit-reset': '4', 'x-ratelimit-remaining': '0' })
    expect(headerNumber(h, 'x-ratelimit-remaining')).toBe(0)
    expect(headerNumber(h, 'x-missing')).toBeNull()
    expect(resetWaitMs(h)).toBe(5000)
    expect(resetWaitMs(new Headers())).toBeNull()
  })

  it('has no write helper anywhere in the module', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./un1t-online.js', import.meta.url), 'utf8')
    expect(src).not.toMatch(/['"`](POST|PUT|PATCH|DELETE)['"`]/)
  })
})
