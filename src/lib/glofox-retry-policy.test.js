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
  fetchPaymentsReport, searchGlofoxMember, getGlofoxInvoicePaymentLink, fetchBranchLeads,
  purchaseGlofoxMembership, createBooking, interpretBookingResult, findLandedBooking,
  cancelBooking, findBookingCancelState, registerGlofoxMember,
  createGlofoxInteraction, cancelGlofoxMembership, updateGlofoxMember,
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
    // The last 5xx is read too (review, GLOFOXPOSTRETRY.1), but only to report
    // a landing: an 'absent' there re-sends nothing.
    expect(verify).toHaveBeenCalledTimes(4)
    expect(glofoxHttpStatsSince(before)).toMatchObject({ requests: 4, retries: 3, verify_absent: 4, gave_up: 1 })
  })

  it('the LAST 5xx of the budget is still checked: a landing there is reported, never re-sent', async () => {
    fetch.mockResolvedValue(res(503))
    const verify = vi.fn()
      .mockResolvedValueOnce('absent').mockResolvedValueOnce('absent').mockResolvedValueOnce('absent')
      .mockResolvedValueOnce('landed')
    const before = glofoxHttpStats()
    const r = await glofoxFetch(creds, '/2.0/things', { method: 'POST', retry: { verify } })
    expect(r.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(verify).toHaveBeenCalledTimes(4)
    expect(glofoxHttpStatsSince(before)).toMatchObject({ requests: 4, retries: 3, verify_landed: 1, gave_up: 0 })
    expect(logWarn).toHaveBeenCalledWith('glofox', 'Glofox write answered 5xx; not retried', {
      status: 503, attempts: 4, path: '/2.0/things', reason: 'landed',
    })
  })

  it("a 'never' write whose 5xx comes on the last attempt (after 429s) is counted as not re-sent, not as a give-up", async () => {
    fetch.mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(503))
    const before = glofoxHttpStats()
    const r = await glofoxFetch(creds, '/2.0/things', { method: 'POST', retry: 'never' })
    expect(r.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(glofoxHttpStatsSince(before)).toMatchObject({ requests: 4, retries: 3, unsafe_not_retried: 1, gave_up: 0 })
    expect(logWarn).toHaveBeenCalledWith('glofox', 'Glofox write answered 5xx; not retried', {
      status: 503, attempts: 4, path: '/2.0/things', reason: 'never',
    })
  })
})

describe('reads that are POSTs keep their 5xx retries', () => {
  it('fetchPaymentsReport: a 503 then a 200 → the report', async () => {
    fetch.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200, { data: [] }))
    const out = await fetchPaymentsReport(creds, { namespace: 'ns' })
    expect(out.ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('searchGlofoxMember (v3 namespace search): a 503 then a 200 → found', async () => {
    fetch.mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200, { data: [{ id: 'f'.repeat(24), email: 'sam@x.com' }] }))
    const out = await searchGlofoxMember(creds, { email: 'Sam@X.com' })
    expect(out).toMatchObject({ found: true, error: null })
    expect(out.member._id).toBe('f'.repeat(24))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('getGlofoxInvoicePaymentLink: a 503 then a 200 → the link (a lost link is a lost reminder)', async () => {
    fetch.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200, {
      is_retriable: true, invoice_payment_link: 'https://pay.example.test/x', invoice_amount: 5000, invoice_currency: 'EUR',
    }))
    const out = await getGlofoxInvoicePaymentLink(creds, { memberId: 'a'.repeat(24), invoiceId: 'inv-1' })
    expect(out).toMatchObject({ ok: true, link: 'https://pay.example.test/x' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('fetchBranchLeads (a leads filter, a POST): a 503 then a 200 → the page', async () => {
    fetch.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200, { data: [{ _id: 'f'.repeat(24) }], total_count: 1 }))
    const out = await fetchBranchLeads(creds, {})
    expect(out).toMatchObject({ total: 1 })
    expect(out.data).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('purchaseGlofoxMembership — a trial is never bought twice', () => {
  it('a 503 then a 200: the purchase is sent exactly ONCE, not granted, outcome unknown', async () => {
    fetch.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200, { success: true, status: 'SUCCESS' }))
    const out = await purchaseGlofoxMembership(creds, 'u1', 'm1', 'p1')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ ok: false, http_status: 503, outcome_unknown: true })
  })

  it('a refusal Glofox answered is a KNOWN outcome', async () => {
    fetch.mockResolvedValueOnce(res(200, { success: false, message_code: 'PURCHASE_NOT_ALLOWED', status: 'ERROR' }))
    const out = await purchaseGlofoxMembership(creds, 'u1', 'm1', 'p1')
    expect(out.ok).toBe(false)
    expect(out.outcome_unknown).toBeUndefined()
  })

  it('a network throw is an unknown outcome', async () => {
    fetch.mockRejectedValueOnce(new Error('socket hang up'))
    const out = await purchaseGlofoxMembership(creds, 'u1', 'm1', 'p1')
    expect(out).toMatchObject({ ok: false, http_status: 0, outcome_unknown: true })
  })

  it('a 429 is retried (Glofox did not process it) and the purchase then goes through', async () => {
    fetch.mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200, { success: true, status: 'SUCCESS', invoice_id: 'inv-9' }))
    const out = await purchaseGlofoxMembership(creds, 'u1', 'm1', 'p1')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(out).toMatchObject({ ok: true, invoice_id: 'inv-9' })
    expect(out.outcome_unknown).toBeUndefined()
  })
})

// Answer each fetch from a per-endpoint queue keyed "METHOD /path" (prefix
// match; query and the /prod base dropped). An unexpected call throws, so a
// re-send nobody queued fails the test loudly.
const key = (url, init) => `${(init?.method || 'GET').toUpperCase()} ${new URL(url).pathname.replace(/^\/prod/, '')}`
function route(table) {
  fetch.mockImplementation(async (url, init) => {
    const k = key(url, init)
    for (const [prefix, queue] of table) {
      if (k.startsWith(prefix) && queue.length) return queue.shift()
    }
    throw new Error(`unexpected ${k}`)
  })
}
const sent = () => fetch.mock.calls.map(([url, init]) => key(url, init))

const USER = 'a'.repeat(24)
const EVENT = 'e'.repeat(24)
const BOOKING = 'b'.repeat(24)
const bookReq = { user_id: USER, model: 'event', model_id: EVENT }

describe('createBooking — re-sent only after a negative dedupe read', () => {
  it('a 503 whose booking DID land: one POST, the read, no second POST; reported booked with its id', async () => {
    route([
      ['POST /2.0/bookings', [res(503)]],
      ['GET /2.0/bookings', [res(200, { data: [{ _id: BOOKING, model_id: EVENT, status: 'BOOKED' }] })]],
    ])
    const out = await createBooking(creds, bookReq)
    expect(sent()).toEqual(['POST /2.0/bookings', 'GET /2.0/bookings'])
    expect(interpretBookingResult(out)).toMatchObject({ booked: true, bookingId: BOOKING, messageCode: null })
    expect(out.recovered).toBe('landed_after_5xx')
  })

  it('a 503 whose booking did NOT land: the read, then exactly one re-send', async () => {
    route([
      ['POST /2.0/bookings', [res(503), res(200, { success: true, Booking: { _id: BOOKING } })]],
      ['GET /2.0/bookings', [res(200, { data: [] })]],
    ])
    const out = await createBooking(creds, bookReq)
    expect(sent()).toEqual(['POST /2.0/bookings', 'GET /2.0/bookings', 'POST /2.0/bookings'])
    expect(interpretBookingResult(out)).toMatchObject({ booked: true, bookingId: BOOKING })
    expect(out.recovered).toBeUndefined()
  })

  it('a CANCELLED booking for the event, or a booking for another event, is not "landed"', async () => {
    route([
      ['POST /2.0/bookings', [res(503), res(200, { success: true, Booking: { _id: BOOKING } })]],
      ['GET /2.0/bookings', [res(200, { data: [
        { _id: 'c'.repeat(24), model_id: EVENT, status: 'CANCELED' },
        { _id: 'd'.repeat(24), model_id: 'f'.repeat(24), status: 'BOOKED' },
      ] })]],
    ])
    await createBooking(creds, bookReq)
    expect(sent().filter((s) => s === 'POST /2.0/bookings')).toHaveLength(2)
  })

  it('the dedupe read FAILS: no re-send; the 5xx goes back to the caller as not booked', async () => {
    route([
      ['POST /2.0/bookings', [res(503)]],
      ['GET /2.0/bookings', [res(500), res(500), res(500), res(500)]],
    ])
    const out = await createBooking(creds, bookReq)
    expect(sent().filter((s) => s === 'POST /2.0/bookings')).toHaveLength(1)
    expect(out.status).toBe(503)
    expect(interpretBookingResult(out).booked).toBe(false)
  })

  it('a 429 is re-sent with no read (Glofox did not process it)', async () => {
    route([['POST /2.0/bookings', [res(429), res(200, { success: true, Booking: { _id: BOOKING } })]]])
    const out = await createBooking(creds, bookReq)
    expect(sent()).toEqual(['POST /2.0/bookings', 'POST /2.0/bookings'])
    expect(interpretBookingResult(out).booked).toBe(true)
  })

  it('no member or event id to check against → never re-sent after a 5xx', async () => {
    route([['POST /2.0/bookings', [res(503)]]])
    const out = await createBooking(creds, { user_id: USER })
    expect(sent()).toEqual(['POST /2.0/bookings'])
    expect(out.status).toBe(503)
  })

  it('the master route shape ({ user_id, event_id }) is checked on event_id', async () => {
    route([
      ['POST /2.0/bookings', [res(503)]],
      ['GET /2.0/bookings', [res(200, { data: [{ _id: BOOKING, model_id: EVENT, status: 'BOOKED' }] })]],
    ])
    const out = await createBooking(creds, { user_id: USER, event_id: EVENT, branch_id: 'br-1' })
    expect(out.recovered).toBe('landed_after_5xx')
  })
})

describe('findLandedBooking', () => {
  it("reads the member's own bookings and matches the event on model_id or event_id (a waitlist entry counts)", async () => {
    route([['GET /2.0/bookings', [res(200, { data: [{ id: BOOKING, event_id: EVENT, status: 'WAITING' }] })]]])
    const out = await findLandedBooking(creds, USER, EVENT)
    expect(out.state).toBe('landed')
    const [url] = fetch.mock.calls[0]
    expect(new URL(url).searchParams.get('user_id')).toBe(USER)
  })
})

describe('cancelBooking — re-sent only while the booking is still live', () => {
  const CANCEL = `POST /booking/${BOOKING}/user/${USER}/cancel`

  it('a 503 whose cancel DID land: no re-send, reported ok', async () => {
    route([
      [CANCEL, [res(503)]],
      ['GET /2.0/bookings', [res(200, { data: [{ _id: BOOKING, model_id: EVENT, status: 'CANCELLED' }] })]],
    ])
    const out = await cancelBooking(creds, BOOKING, USER)
    expect(sent()).toEqual([CANCEL, 'GET /2.0/bookings'])
    expect(out).toMatchObject({ ok: true, status: 200, recovered: 'landed_after_5xx' })
  })

  it('a 503 and the booking is still BOOKED: exactly one re-send', async () => {
    route([
      [CANCEL, [res(503), res(200, { success: true })]],
      ['GET /2.0/bookings', [res(200, { data: [{ _id: BOOKING, model_id: EVENT, status: 'BOOKED' }] })]],
    ])
    const out = await cancelBooking(creds, BOOKING, USER)
    expect(sent()).toEqual([CANCEL, 'GET /2.0/bookings', CANCEL])
    expect(out.ok).toBe(true)
  })

  it('the booking is not in the read, or the read fails: no re-send, the 5xx comes back', async () => {
    for (const gets of [[res(200, { data: [] })], [res(500), res(500), res(500), res(500)]]) {
      fetch.mockReset()
      route([[CANCEL, [res(503)]], ['GET /2.0/bookings', gets]])
      const out = await cancelBooking(creds, BOOKING, USER)
      expect(sent().filter((s) => s === CANCEL)).toHaveLength(1)
      expect(out).toMatchObject({ ok: false, status: 503 })
    }
  })
})

describe('findBookingCancelState', () => {
  it('matches the booking on _id or id, and reads either cancelled spelling', async () => {
    route([['GET /2.0/bookings', [
      res(200, { data: [{ id: BOOKING, status: 'CANCELED' }] }),
      res(200, { data: [{ _id: BOOKING, status: 'BOOKED' }] }),
    ]]])
    expect(await findBookingCancelState(creds, USER, BOOKING)).toBe('landed')
    expect(await findBookingCancelState(creds, USER, BOOKING)).toBe('absent')
  })
})

describe('registerGlofoxMember — re-sent only when the email search finds no account', () => {
  const payload = { first_name: 'Sam', last_name: 'Lee', email: 'Sam@X.com', password: 'Abcd-1234' }
  const NEW = 'c'.repeat(24)

  it('a 503 whose account WAS created: no re-send; the found member comes back', async () => {
    route([
      ['POST /2.0/register', [res(503)]],
      ['POST /v3.0/namespaces/members/retrieve', [res(200, { data: [{ id: NEW, email: 'sam@x.com' }] })]],
    ])
    const out = await registerGlofoxMember(creds, payload)
    expect(sent()).toEqual(['POST /2.0/register', 'POST /v3.0/namespaces/members/retrieve'])
    expect(out).toMatchObject({ ok: true, error: null, recovered: 'landed_after_5xx' })
    expect(out.member._id).toBe(NEW)
  })

  it('a 503 and no account under the email: exactly one re-send', async () => {
    route([
      ['POST /2.0/register', [res(503), res(200, { user: { _id: NEW } })]],
      ['POST /v3.0/namespaces/members/retrieve', [res(200, { data: [] })]],
    ])
    const out = await registerGlofoxMember(creds, payload)
    expect(sent()).toEqual(['POST /2.0/register', 'POST /v3.0/namespaces/members/retrieve', 'POST /2.0/register'])
    expect(out).toMatchObject({ ok: true, member: { _id: NEW } })
  })

  it('the search fails: no re-send (never create on a failed search)', async () => {
    route([
      ['POST /2.0/register', [res(503)]],
      ['POST /v3.0/namespaces/members/retrieve', [res(500), res(500), res(500), res(500)]],
    ])
    const out = await registerGlofoxMember(creds, payload)
    expect(sent().filter((s) => s === 'POST /2.0/register')).toHaveLength(1)
    expect(out).toMatchObject({ ok: false, error: 'Glofox HTTP 503' })
  })

  it('the search finds MORE than one account: no re-send and no guess at which one', async () => {
    route([
      ['POST /2.0/register', [res(503)]],
      ['POST /v3.0/namespaces/members/retrieve', [res(200, { data: [{ id: NEW, email: 'sam@x.com' }, { id: 'd'.repeat(24), email: 'sam@x.com' }] })]],
    ])
    const out = await registerGlofoxMember(creds, payload)
    expect(sent().filter((s) => s === 'POST /2.0/register')).toHaveLength(1)
    expect(out).toMatchObject({ ok: false, member: null })
  })
})

describe('writes with no safe dedupe read are sent once on a 5xx', () => {
  it('createGlofoxInteraction: one send, ok:false (a duplicate note is worse than a push marked failed)', async () => {
    fetch.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200))
    const out = await createGlofoxInteraction(creds, USER, { type: 'NOTE', description: 'hi' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ ok: false, status: 503 })
  })

  it('cancelGlofoxMembership: one send, ok:false', async () => {
    fetch.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200))
    const out = await cancelGlofoxMembership(creds, { userMembershipId: 'd'.repeat(24), memberId: USER, localDate: '2026-11-01', reason: '' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ ok: false, status: 503 })
  })

  it('updateGlofoxMember: one send, ok:false', async () => {
    fetch.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200))
    const out = await updateGlofoxMember(creds, USER, { phone: '+353870000000' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(out.ok).toBe(false)
  })
})
