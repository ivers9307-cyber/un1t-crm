import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/connection-registry', () => ({ readConnection: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }))

import { Un1tBudgetSpent, openUn1tMemberReader, fetchLiveUn1tBookings, UN1T_READ_MAX_PAGES } from './un1t-member-read'
import { fakeUn1tReader, fakeUn1tWrite } from './un1t-fakes.test-helpers'
import { readConnection } from '@/lib/connection-registry'
import { checkRateLimit } from '@/lib/rate-limit'
import { logWarn, logError, logInfo } from '@/lib/log'

const TOKEN = 'tok_secret_abc123_not_real'
const LOC = 'a0000000-0000-0000-0000-00000000000f'
const db = { tag: 'db' }

const activeConn = (over = {}) => ({
  source: 'registry',
  isActive: true,
  accessToken: TOKEN,
  externalAccountId: 'studio-test-1',
  ...over,
})

const res = (status, body, headers = {}) => ({
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  json: async () => body,
})
const ok = (data) => res(200, { success: true, data })

function fetchSeq(responses) {
  const queue = [...responses]
  const fetchImpl = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0]
    return next
  })
  return fetchImpl
}

const allow = { allowed: true, remaining: 29, resetAt: new Date(), retryAfterSec: 30 }
const spent = { allowed: false, remaining: 0, resetAt: new Date(), retryAfterSec: 30 }
const sleep = vi.fn(async () => {})

beforeEach(() => {
  vi.clearAllMocks()
  readConnection.mockResolvedValue({ conn: activeConn(), error: null })
  checkRateLimit.mockResolvedValue(allow)
})

describe('openUn1tMemberReader', () => {
  it('takes one rate slot per request on key un1t-write:<loc>', async () => {
    const fetchImpl = fetchSeq([ok({ a: 1 })])
    const reader = await openUn1tMemberReader(db, LOC, { fetchImpl, sleep })
    expect(reader).toMatchObject({ ok: true, studioId: 'studio-test-1' })
    expect(checkRateLimit).not.toHaveBeenCalled() // opening reads no un1t.online
    await reader.getOne('/users/u1/bookings')
    expect(checkRateLimit).toHaveBeenCalledTimes(1)
    expect(checkRateLimit).toHaveBeenCalledWith(db, `un1t-write:${LOC}`, { max: 30, windowMs: 60_000 })
    await reader.getOne('/users/u1/bookings')
    expect(checkRateLimit).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('a retried request spends a slot for every HTTP attempt', async () => {
    const fetchImpl = fetchSeq([res(503, {}), ok([])])
    const reader = await openUn1tMemberReader(db, LOC, { fetchImpl, sleep })
    await reader.getOne('/users/u1/bookings')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(checkRateLimit).toHaveBeenCalledTimes(2)
  })

  it('a spent slot throws Un1tBudgetSpent and sends nothing', async () => {
    checkRateLimit.mockResolvedValue(spent)
    const fetchImpl = fetchSeq([ok([])])
    const reader = await openUn1tMemberReader(db, LOC, { fetchImpl, sleep })
    const err = await reader.getOne('/users/u1/bookings').catch((e) => e)
    expect(err).toBeInstanceOf(Un1tBudgetSpent)
    expect(err.retryAfterSec).toBe(30)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['no connection', { conn: null, error: null }],
    ['inactive', { conn: activeConn({ isActive: false }), error: null }],
    ['tokenless', { conn: activeConn({ accessToken: null }), error: null }],
    ['legacy source', { conn: activeConn({ source: 'legacy', status: 'not_connected' }), error: null }],
    ['no studio id', { conn: activeConn({ externalAccountId: null }), error: null }],
  ])('%s -> not_connected', async (_name, answer) => {
    readConnection.mockResolvedValue(answer)
    const fetchImpl = fetchSeq([ok([])])
    await expect(openUn1tMemberReader(db, LOC, { fetchImpl, sleep })).resolves.toEqual({ ok: false, reason: 'not_connected' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('an unreadable connection is read_failed, never not_connected', async () => {
    readConnection.mockResolvedValue({ conn: null, error: { code: '57014' } })
    await expect(openUn1tMemberReader(db, LOC, {})).resolves.toEqual({ ok: false, reason: 'read_failed' })
    expect(logWarn).toHaveBeenCalled()
  })

  it('a thrown connection read is read_failed', async () => {
    readConnection.mockRejectedValue(new Error('boom'))
    await expect(openUn1tMemberReader(db, LOC, {})).resolves.toEqual({ ok: false, reason: 'read_failed' })
  })

  it('getOne does one GET and no pagination', async () => {
    const fetchImpl = fetchSeq([ok([{ id: 'b1' }])])
    const reader = await openUn1tMemberReader(db, LOC, { fetchImpl, sleep })
    const data = await reader.getOne('/users/u1/bookings')
    expect(data).toEqual([{ id: 'b1' }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.un1t.online/users/u1/bookings')
    expect(url).not.toMatch(/page=|pageSize=/)
    expect(init.method).toBe('GET')
  })
})

describe('fetchLiveUn1tBookings', () => {
  it('returns the rows of GET /users/{id}/bookings', async () => {
    const fetchImpl = fetchSeq([ok([{ id: 'b1' }, { id: 'b2' }])])
    const out = await fetchLiveUn1tBookings(db, { locationId: LOC, un1tUserId: 'u1' }, { fetchImpl, sleep })
    expect(out).toEqual({ ok: true, rows: [{ id: 'b1' }, { id: 'b2' }] })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.un1t.online/users/u1/bookings?page=1&pageSize=100')
  })

  it('encodes the member id into the path', async () => {
    const fetchImpl = fetchSeq([ok([])])
    await fetchLiveUn1tBookings(db, { locationId: LOC, un1tUserId: 'u 1/../x' }, { fetchImpl, sleep })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.un1t.online/users/u%201%2F..%2Fx/bookings?page=1&pageSize=100')
  })

  const pageOf = (n, pages, rows) => res(200, { success: true, data: rows, pagination: { total: pages * 100, page: n, pages, pageSize: 100 } })
  const rowsFor = (page, n = 100) => Array.from({ length: n }, (_, i) => ({ id: `b${page}-${i}` }))

  it('pages through every page, one budget slot per page', async () => {
    const fetchImpl = fetchSeq([pageOf(1, 3, rowsFor(1)), pageOf(2, 3, rowsFor(2)), pageOf(3, 3, rowsFor(3, 7))])
    const out = await fetchLiveUn1tBookings(db, { locationId: LOC, un1tUserId: 'u1' }, { fetchImpl, sleep })
    expect(out.ok).toBe(true)
    expect(out.rows).toHaveLength(207)
    expect(out.rows[100]).toEqual({ id: 'b2-0' })
    expect(out.truncated).toBeUndefined()
    expect(fetchImpl.mock.calls.map(([u]) => u)).toEqual([1, 2, 3].map((p) => `https://api.un1t.online/users/u1/bookings?page=${p}&pageSize=100`))
    expect(checkRateLimit).toHaveBeenCalledTimes(3)
    expect(checkRateLimit).toHaveBeenCalledWith(db, `un1t-write:${LOC}`, { max: 30, windowMs: 60_000 })
  })

  it('stops at the page cap and says the list is truncated', async () => {
    const pages = UN1T_READ_MAX_PAGES + 4
    const fetchImpl = vi.fn(async (url) => {
      const n = Number(/page=(\d+)/.exec(url)[1])
      return pageOf(n, pages, rowsFor(n))
    })
    const out = await fetchLiveUn1tBookings(db, { locationId: LOC, un1tUserId: 'u1' }, { fetchImpl, sleep })
    expect(out).toMatchObject({ ok: true, truncated: true })
    expect(out.rows).toHaveLength(UN1T_READ_MAX_PAGES * 100)
    expect(fetchImpl).toHaveBeenCalledTimes(UN1T_READ_MAX_PAGES)
    expect(checkRateLimit).toHaveBeenCalledTimes(UN1T_READ_MAX_PAGES)
    const warn = logWarn.mock.calls.find(([m, msg]) => m === 'mia-un1t' && /page cap/.test(msg))
    expect(warn).toBeTruthy()
    expect(warn[2]).not.toHaveProperty('status')
  })

  it('a budget spent on page 2 is budget_spent and returns no rows', async () => {
    checkRateLimit.mockResolvedValueOnce(allow).mockResolvedValue(spent)
    const fetchImpl = fetchSeq([pageOf(1, 3, rowsFor(1)), pageOf(2, 3, rowsFor(2))])
    const out = await fetchLiveUn1tBookings(db, { locationId: LOC, un1tUserId: 'u1' }, { fetchImpl, sleep })
    expect(out).toEqual({ ok: false, reason: 'budget_spent' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a 5xx after retries -> { ok: false, reason: read_failed }', async () => {
    const fetchImpl = fetchSeq([res(503, {})])
    const out = await fetchLiveUn1tBookings(db, { locationId: LOC, un1tUserId: 'u1' }, { fetchImpl, sleep })
    expect(out).toEqual({ ok: false, reason: 'read_failed' })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(logWarn.mock.calls.concat(logError.mock.calls).some(([m, , meta]) => m === 'mia-un1t' && meta?.status === 503)).toBe(true)
  })

  it('a 401 is read_failed and logged with its status', async () => {
    const fetchImpl = fetchSeq([res(401, {})])
    const out = await fetchLiveUn1tBookings(db, { locationId: LOC, un1tUserId: 'u1' }, { fetchImpl, sleep })
    expect(out).toEqual({ ok: false, reason: 'read_failed' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(logError).not.toHaveBeenCalled()
    expect(logWarn.mock.calls.some(([m, , meta]) => m === 'mia-un1t' && meta?.status === 401)).toBe(true)
  })

  it('a spent budget is budget_spent and sends nothing', async () => {
    checkRateLimit.mockResolvedValue(spent)
    const fetchImpl = fetchSeq([ok([])])
    const out = await fetchLiveUn1tBookings(db, { locationId: LOC, un1tUserId: 'u1' }, { fetchImpl, sleep })
    expect(out).toEqual({ ok: false, reason: 'budget_spent' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([['an object', { nope: true }], ['null', null], ['missing', undefined], ['a string', 'abc']])(
    'data that is %s is read_failed, never an empty list',
    async (_name, data) => {
      const fetchImpl = fetchSeq([res(200, { success: true, data })])
      const out = await fetchLiveUn1tBookings(db, { locationId: LOC, un1tUserId: 'u1' }, { fetchImpl, sleep })
      expect(out).toEqual({ ok: false, reason: 'read_failed' })
    },
  )

  it('a list holding something that is not a booking object is read_failed', async () => {
    const fetchImpl = fetchSeq([ok([{ id: 'b1' }, 'x'])])
    const out = await fetchLiveUn1tBookings(db, { locationId: LOC, un1tUserId: 'u1' }, { fetchImpl, sleep })
    expect(out).toEqual({ ok: false, reason: 'read_failed' })
  })

  it('passes not_connected through, and refuses a missing id without a request', async () => {
    readConnection.mockResolvedValue({ conn: null, error: null })
    const fetchImpl = fetchSeq([ok([])])
    expect(await fetchLiveUn1tBookings(db, { locationId: LOC, un1tUserId: 'u1' }, { fetchImpl, sleep }))
      .toEqual({ ok: false, reason: 'not_connected' })
    readConnection.mockResolvedValue({ conn: activeConn(), error: null })
    expect(await fetchLiveUn1tBookings(db, { locationId: LOC, un1tUserId: '' }, { fetchImpl, sleep }))
      .toEqual({ ok: false, reason: 'read_failed' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('the token never appears in a thrown error or a log call', async () => {
    const seen = []
    // A network fault whose message an unwary client could have built from the request.
    const fetchImpl = vi.fn(async () => { throw new Error('socket hang up') })
    const reader = await openUn1tMemberReader(db, LOC, { fetchImpl, sleep })
    const err = await reader.getOne('/users/u1/bookings').catch((e) => e)
    seen.push(String(err?.message), String(err?.stack ?? '').split('\n')[0])
    for (const resp of [res(503, {}), res(401, {}), res(500, { error: { message: 'bad' } })]) {
      await fetchLiveUn1tBookings(db, { locationId: LOC, un1tUserId: 'u1' }, { fetchImpl: fetchSeq([resp]), sleep })
    }
    checkRateLimit.mockResolvedValue(spent)
    const budgetErr = await (await openUn1tMemberReader(db, LOC, { fetchImpl, sleep })).getOne('/x').catch((e) => e)
    seen.push(String(budgetErr.message))
    for (const fn of [logWarn, logError, logInfo]) seen.push(JSON.stringify(fn.mock.calls))
    expect(logWarn.mock.calls.length + logError.mock.calls.length).toBeGreaterThan(0)
    expect(seen.join('\n')).not.toContain(TOKEN)
  })

  it('the log lines of this module name mia-un1t and carry no email, phone or name fields', async () => {
    await fetchLiveUn1tBookings(db, { locationId: LOC, un1tUserId: 'u1' }, { fetchImpl: fetchSeq([res(503, {})]), sleep })
    // The client's own retry lines come from module 'un1t-online' (status and
    // path, no token); the lines THIS module writes are the ones pinned here.
    const calls = logWarn.mock.calls.concat(logError.mock.calls).filter(([module]) => module !== 'un1t-online')
    expect(calls.length).toBeGreaterThan(0)
    for (const [module, , meta] of calls) {
      expect(module).toBe('mia-un1t')
      expect(Object.keys(meta ?? {}).filter((k) => /email|phone|name|token|url|path/i.test(k))).toEqual([])
    }
  })
})

describe('test helpers', () => {
  it('fakeUn1tReader routes by path, records calls and can fail', async () => {
    const r = fakeUn1tReader({ bookings: [{ id: 'b1' }], ledger: [{ id: 'l1' }], history: [{ id: 'h1' }] })
    expect(await r.getOne('/users/u1/bookings')).toEqual([{ id: 'b1' }])
    expect(await r.listAll('/users/u1/bookings')).toEqual({ rows: [{ id: 'b1' }], total: 1, truncated: false })
    expect(await r.getOne('/users/u1/ledger')).toEqual([{ id: 'l1' }])
    expect(await r.getOne('/users/u1/history')).toEqual([{ id: 'h1' }])
    expect(r.calls).toEqual(['/users/u1/bookings', '/users/u1/bookings', '/users/u1/ledger', '/users/u1/history'])
    await expect(fakeUn1tReader({ fail: 503 }).getOne('/users/u1/bookings')).rejects.toMatchObject({ status: 503 })
    await expect(fakeUn1tReader({ fail: 'budget' }).getOne('/users/u1/bookings')).rejects.toBeInstanceOf(Un1tBudgetSpent)
    await expect(fakeUn1tReader({ fail: 503 }).listAll('/users/u1/bookings')).rejects.toMatchObject({ status: 503 })
    expect(await fakeUn1tReader({ bookings: [{ id: 'b1' }], truncated: true }).listAll('/users/u1/bookings')).toMatchObject({ truncated: true })
  })

  it('fakeUn1tWrite keys factories by real module path and records calls', async () => {
    const w = fakeUn1tWrite({ book: vi.fn(async () => ({ ok: false, code: 'X' })) })
    expect(Object.keys(w).filter((k) => k.startsWith('@/'))).toEqual([
      '@/lib/un1t-online-write',
      '@/lib/un1t-online-write-ops',
      '@/lib/un1t-online-approval',
    ])
    const ops = w['@/lib/un1t-online-write-ops']()
    expect(await ops.book({ a: 1 })).toEqual({ ok: false, code: 'X' })
    expect(await ops.cancel({ b: 2 })).toEqual({ ok: true })
    expect(w.fns.book).toHaveBeenCalledWith({ a: 1 })
    expect(w.fns.cancel).toHaveBeenCalledTimes(1)
    const { Un1tWriteRefused, Un1tWriteUnknown } = w['@/lib/un1t-online-write']()
    expect(new Un1tWriteRefused('C', 'm').code).toBe('C')
    expect(new Un1tWriteUnknown('C', 'm')).toBeInstanceOf(Error)
    expect(Object.keys(w['@/lib/un1t-online-approval']()).sort()).toEqual(['executeUn1tApproval', 'fileRefundCard'])
  })
})
