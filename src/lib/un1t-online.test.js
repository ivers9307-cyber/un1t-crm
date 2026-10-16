// Tests for the GET-only un1t.online client (UN1TSYNC.2). A fake fetch only:
// nothing here reaches the real api.un1t.online.

import { describe, it, expect, vi } from 'vitest'
import { createUn1tClient, Un1tAuthError, Un1tApiError } from './un1t-online'

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
    expect(Object.keys(createUn1tClient({ token: 't' }))).toEqual(['getSelf', 'listAll', 'stats'])
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

  it('never puts the token in an error message', async () => {
    const { client } = setup([res(401, {})])
    const err = await client.getSelf().catch((e) => e)
    expect(err.message).not.toContain('Bearer')
  })

  it('has no write helper anywhere in the module', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./un1t-online.js', import.meta.url), 'utf8')
    expect(src).not.toMatch(/['"`](POST|PUT|PATCH|DELETE)['"`]/)
  })
})
