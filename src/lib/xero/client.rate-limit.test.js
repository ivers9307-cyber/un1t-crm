// XERO429.1 — xfetch waits out a 429 when the wait fits the caller's budget.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const conn = { id: 'conn-1', location_id: 'loc-1', tenant_id: 'tenant-1', access_token: 'tok', refresh_token: 'ref', expires_at: '2099-01-01T00:00:00.000Z' }
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: conn, error: null }) }) }) }),
  }),
}))

const { withFreshToken, XeroError, retryAfterMsOf, MAX_RATE_LIMIT_ATTEMPTS } = await import('./client.js')

const limited = (retryAfter = '1', problem = 'minute') => new Response('', { status: 429, headers: { 'retry-after': retryAfter, 'x-rate-limit-problem': problem } })
const ok = (body = { Invoices: [] }) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
let fetchMock
let sleep

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  sleep = vi.fn(async () => {})
})
afterEach(() => vi.unstubAllGlobals())

describe('retryAfterMsOf', () => {
  it('reads seconds, and falls back to two seconds when the header is missing or unreadable', () => {
    expect(retryAfterMsOf(limited('7'))).toBe(7000)
    expect(retryAfterMsOf(limited('0'))).toBe(0)
    expect(retryAfterMsOf(new Response('', { status: 429 }))).toBe(2000)
    expect(retryAfterMsOf(limited('soon'))).toBe(2000)
  })
})

describe('xfetch on a 429', () => {
  it('waits what Xero asked (and a little more) and repeats the same request', async () => {
    fetchMock.mockResolvedValueOnce(limited('2')).mockResolvedValueOnce(ok({ Invoices: [{ InvoiceID: 'b1' }] }))
    const { xfetch } = await withFreshToken('loc-1', { sleep })
    const out = await xfetch('/Invoices', { method: 'POST', body: { Invoices: [{ a: 1 }] } })
    expect(out).toEqual({ Invoices: [{ InvoiceID: 'b1' }] })
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(2000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body)
    expect(fetchMock.mock.calls[1][1].headers['Xero-Tenant-Id']).toBe('tenant-1')
  })

  it('by default does not wait out a whole minute: it fails as rate_limited with the wait', async () => {
    fetchMock.mockResolvedValueOnce(limited('45'))
    const { xfetch } = await withFreshToken('loc-1', { sleep })
    const err = await xfetch('/Invoices').catch((e) => e)
    expect(err).toBeInstanceOf(XeroError)
    expect(err).toMatchObject({ status: 429, code: 'rate_limited' })
    expect(err.body.retryAfterMs).toBe(45000)
    expect(err.message).toMatch(/Wait a minute/)
    expect(sleep).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a caller with a larger budget waits the minute out', async () => {
    fetchMock.mockResolvedValueOnce(limited('45')).mockResolvedValueOnce(ok())
    const { xfetch } = await withFreshToken('loc-1', { sleep, rateLimitWaitMs: 65_000 })
    await xfetch('/Invoices')
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(45000)
  })

  it('never waits for the daily limit', async () => {
    fetchMock.mockResolvedValueOnce(limited('1', 'day'))
    const { xfetch } = await withFreshToken('loc-1', { sleep, rateLimitWaitMs: 65_000 })
    const err = await xfetch('/Invoices').catch((e) => e)
    expect(err).toMatchObject({ status: 429, code: 'rate_limited_day' })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('gives up after the last attempt', async () => {
    fetchMock.mockImplementation(async () => limited('1'))
    const { xfetch } = await withFreshToken('loc-1', { sleep })
    const err = await xfetch('/Invoices').catch((e) => e)
    expect(err).toMatchObject({ code: 'rate_limited' })
    expect(fetchMock).toHaveBeenCalledTimes(MAX_RATE_LIMIT_ATTEMPTS)
    expect(sleep).toHaveBeenCalledTimes(MAX_RATE_LIMIT_ATTEMPTS - 1)
  })

  it('a file download waits and repeats too', async () => {
    fetchMock.mockResolvedValueOnce(limited('1')).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    const { xfetch } = await withFreshToken('loc-1', { sleep })
    expect(Array.from(await xfetch('/Invoices/x', { responseType: 'buffer' }))).toEqual([1, 2, 3])
  })

  it('any other failure is thrown at once, as before', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ Message: 'bad' }), { status: 400 }))
    const { xfetch } = await withFreshToken('loc-1', { sleep })
    const err = await xfetch('/Invoices').catch((e) => e)
    expect(err).toMatchObject({ status: 400, message: 'bad' })
    expect(sleep).not.toHaveBeenCalled()
  })
})
