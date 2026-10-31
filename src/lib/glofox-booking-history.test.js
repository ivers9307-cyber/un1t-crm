// ATTHISTORY.1 — fetchUserBookingHistoryResult pages /2.0/bookings to the end.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchUserBookingHistoryResult, BOOKING_HISTORY_PAGE_SIZE } from './glofox.js'

const creds = { branchId: 'br-1', apiKey: 'k', apiToken: 't' }
const pageOf = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ _id: `b-${from + i}`, attended: i % 2 === 0, status: 'BOOKED', time_start: 1_700_000_000 - (from + i) * 86400 }))
const okJson = (data) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data }), text: async () => JSON.stringify({ data }) })

describe('fetchUserBookingHistoryResult', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))

  it('reads page after page until a short page, and asks for a ten-year window', async () => {
    fetch
      .mockResolvedValueOnce(okJson(pageOf(BOOKING_HISTORY_PAGE_SIZE, 0)))
      .mockResolvedValueOnce(okJson(pageOf(BOOKING_HISTORY_PAGE_SIZE, 100)))
      .mockResolvedValueOnce(okJson(pageOf(7, 200)))
    const r = await fetchUserBookingHistoryResult(creds, 'u-1')
    expect(r.ok).toBe(true)
    expect(r.bookings).toHaveLength(207)
    expect(r.pages).toBe(3)
    expect(r.truncated).toBe(false)
    const urls = fetch.mock.calls.map(([u]) => new URL(String(u)))
    expect(urls.map((u) => u.searchParams.get('page'))).toEqual(['1', '2', '3'])
    expect(urls.every((u) => u.searchParams.get('limit') === '100')).toBe(true)
    const cutoff = Number(urls[0].searchParams.get('time_start'))
    const yearsBack = (Date.now() / 1000 - cutoff) / (365 * 86400)
    expect(yearsBack).toBeGreaterThan(9.9)
  })

  it('stops after one short page (the common case: a member with a few bookings)', async () => {
    fetch.mockResolvedValueOnce(okJson(pageOf(3)))
    const r = await fetchUserBookingHistoryResult(creds, 'u-1')
    expect(r).toMatchObject({ ok: true, pages: 1, truncated: false })
    expect(r.bookings).toHaveLength(3)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('an empty first page is ok with no bookings (not a failure)', async () => {
    fetch.mockResolvedValueOnce(okJson([]))
    const r = await fetchUserBookingHistoryResult(creds, 'u-1')
    expect(r).toEqual({ ok: true, bookings: [], pages: 1, truncated: false })
  })

  it('a failed later page fails the WHOLE read: a partial newest-first history must not be read as "never attended"', async () => {
    fetch
      .mockResolvedValueOnce(okJson(pageOf(BOOKING_HISTORY_PAGE_SIZE, 0)))
      .mockResolvedValueOnce({ ok: false, status: 401, headers: new Headers(), json: async () => ({}), text: async () => '' })
    const r = await fetchUserBookingHistoryResult(creds, 'u-1', { maxPages: 5 })
    expect(r).toEqual({ ok: false, bookings: [], pages: 2 })
  })

  it('reports truncated at the page cap and still answers ok', async () => {
    fetch.mockResolvedValue(okJson(pageOf(BOOKING_HISTORY_PAGE_SIZE)))
    const r = await fetchUserBookingHistoryResult(creds, 'u-1', { maxPages: 2 })
    expect(r.ok).toBe(true)
    expect(r.truncated).toBe(true)
    expect(r.pages).toBe(2)
    expect(r.bookings).toHaveLength(200)
  })
})
