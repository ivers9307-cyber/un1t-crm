// PAYLINK.1 — POST /v3.0/payment-links/invoices/{invoiceID} answers with the
// three integration headers + x-glofox-impersonated-member-id (verified live
// 2026-09-12 on a €209 overdue renewal). The spec's "Bearer member JWT" is
// wrong for integrators: headers alone 403, a Bearer of the api token 401.
//
// PAYLINK.1b (code-quality follow-up): a 200 can still be
// `success:false` (Glofox's own "treat it as a 400" convention — see
// GLOFOX-SPEC-2026-09 in glofoxFetch); a non-2xx keeps Glofox's own
// message_code/code when the body carries one; amountCents and link are
// sanity-checked before being trusted; args are defaulted so a missing
// second argument can't throw; a misconfigured location (missing apiKey/
// apiToken) reads as INVALID_ARGS rather than reaching the network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }
const MEMBER = '679bfd4c2f6535e4f200078e'
const INVOICE = '0f187762-acc8-42d2-860c-43cbe1477df0'

const res = (status, body) => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null },
  json: async () => body, clone() { return this },
})

// A response whose body isn't JSON at all (e.g. an HTML error page from a
// proxy in front of Glofox) — json() rejects, same as the real fetch API.
const resBadJson = (status) => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null },
  json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
  clone() { return this },
})

describe('getGlofoxInvoicePaymentLink', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('posts with the impersonation header and returns the link, amount and summary', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, {
      invoice_id: INVOICE, is_retriable: true,
      invoice_payment_link: `https://pay.glofox.com/payment-collector/v2/#/i/${INVOICE}`,
      invoice_summary: 'Month to Month Membership (7983610)', invoice_amount: 20900, invoice_currency: 'EUR',
      utc_invoice_timestamp: '2026-09-11T20:04:12Z',
    }))
    const r = await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE })
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toContain(`/v3.0/payment-links/invoices/${INVOICE}`)
    expect(init.method).toBe('POST')
    expect(init.headers['x-glofox-impersonated-member-id']).toBe(MEMBER)
    expect(init.headers['x-glofox-api-token']).toBe('t')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers['x-glofox-branch-id']).toBe('b')
    // PAYLINK.4b — this call sits on the webhook request path and on an
    // operator's button, so it must not inherit glofoxFetch's unbounded wait.
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(r).toEqual({
      ok: true, status: 200, retriable: true, invoiceId: INVOICE,
      link: `https://pay.glofox.com/payment-collector/v2/#/i/${INVOICE}`,
      amountCents: 20900, currency: 'EUR', summary: 'Month to Month Membership (7983610)', error: null,
    })
  })

  it('PAYLINK.4b — a timed-out fetch reports error:"timeout", not the raw AbortError message', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    const r = await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE })
    expect(r).toMatchObject({ ok: false, status: 0, error: 'timeout' })
  })

  it('a non-retriable invoice is ok:true with no link (a fee, or Glofox mid-retry)', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { invoice_id: INVOICE, is_retriable: false }))
    const r = await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE })
    expect(r).toMatchObject({ ok: true, retriable: false, link: null, amountCents: null, currency: null, error: null })
  })

  it('a 200 with success:false is a failure, not "not retriable" (GLOFOX-SPEC-2026-09)', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { success: false, message_code: 'INVOICE_NOT_FOUND' }))
    const r = await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE })
    expect(r).toMatchObject({ ok: false, status: 200, retriable: false, link: null, error: 'INVOICE_NOT_FOUND' })
  })

  it('a non-2xx keeps Glofox\'s own message_code/code in the error', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(403, { code: 'NOT_AUTHORIZED' }))
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE }))
      .toMatchObject({ ok: false, status: 403, link: null, error: 'Glofox HTTP 403 (NOT_AUTHORIZED)' })
  })

  it('a non-2xx with a non-JSON body falls back to the bare status', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(resBadJson(403))
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE }))
      .toMatchObject({ ok: false, status: 403, link: null, error: 'Glofox HTTP 403' })
  })

  it('amountCents is null unless invoice_amount is a finite number greater than 0', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { invoice_id: INVOICE, is_retriable: true, invoice_amount: null }))
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE }))
      .toMatchObject({ ok: true, retriable: true, amountCents: null })

    global.fetch.mockResolvedValueOnce(res(200, { invoice_id: INVOICE, is_retriable: true, invoice_amount: 0 }))
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE }))
      .toMatchObject({ ok: true, retriable: true, amountCents: null })
  })

  it('link is accepted only when it is a string starting with https://', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, {
      invoice_id: INVOICE, is_retriable: true, invoice_payment_link: 'javascript:alert(1)',
    }))
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE }))
      .toMatchObject({ ok: true, retriable: true, link: null })
  })

  it('refuses bad ids locally without calling Glofox', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: 'nope', invoiceId: INVOICE })).toMatchObject({ ok: false, status: 400, error: 'INVALID_ARGS' })
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: '' })).toMatchObject({ ok: false, status: 400, error: 'INVALID_ARGS' })
    expect(await getGlofoxInvoicePaymentLink(null, { memberId: MEMBER, invoiceId: INVOICE })).toMatchObject({ ok: false, status: 400, error: 'INVALID_ARGS' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('a local-validation failure reports the trimmed invoiceId, not the raw argument', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    const r = await getGlofoxInvoicePaymentLink(creds, { memberId: 'nope', invoiceId: `  ${INVOICE}  ` })
    expect(r).toMatchObject({ ok: false, status: 400, error: 'INVALID_ARGS', invoiceId: INVOICE })
  })

  it('a missing or null args object is INVALID_ARGS, never a throw', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    expect(await getGlofoxInvoicePaymentLink(creds, null)).toMatchObject({ ok: false, status: 400, error: 'INVALID_ARGS' })
    expect(await getGlofoxInvoicePaymentLink(creds)).toMatchObject({ ok: false, status: 400, error: 'INVALID_ARGS' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('a misconfigured location (missing apiKey or apiToken) is INVALID_ARGS, not a network call', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    expect(await getGlofoxInvoicePaymentLink({ branchId: 'b', apiToken: 't' }, { memberId: MEMBER, invoiceId: INVOICE }))
      .toMatchObject({ ok: false, status: 400, error: 'INVALID_ARGS' })
    expect(await getGlofoxInvoicePaymentLink({ branchId: 'b', apiKey: 'k' }, { memberId: MEMBER, invoiceId: INVOICE }))
      .toMatchObject({ ok: false, status: 400, error: 'INVALID_ARGS' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('a thrown fetch becomes ok:false with the message', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockRejectedValueOnce(new Error('socket hang up'))
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE }))
      .toMatchObject({ ok: false, status: 0, link: null, error: 'socket hang up' })
  })
})

// PAYLINK.5b — the 8s payment-link timebox (GLOFOX_PAYMENT_LINK_TIMEOUT_MS)
// is only real if it also bounds glofoxFetch's own retry-backoff sleeps; an
// aborted signal that only stopped the fetch itself would still leave the
// caller waiting out up to 3 full backoff sleeps (~8s) after the abort.
describe('glofoxFetch — abortable retry backoff (PAYLINK.5b)', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('an already-aborted signal stops the retry loop after exactly one attempt, returning the last response', async () => {
    const { glofoxFetch } = await import('./glofox.js')
    global.fetch.mockResolvedValue(res(500, {}))
    const r = await glofoxFetch(creds, '/2.0/members', { signal: AbortSignal.abort() })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(r.status).toBe(500)
  })

  it('_glofoxSleep resolves promptly on an already-aborted signal, never waiting out the full delay', async () => {
    const { _glofoxSleep } = await import('./glofox.js')
    const start = Date.now()
    await _glofoxSleep(10_000, AbortSignal.abort())
    expect(Date.now() - start).toBeLessThan(1000)
  })

  // PAYLINK.6 — the sibling case: a signal that is NOT yet aborted when
  // _glofoxSleep is called, but fires its 'abort' EVENT mid-sleep. No
  // existing test reaches the addEventListener('abort', onAbort) path —
  // the test above hits the early `signal?.aborted` return instead.
  it('_glofoxSleep resolves promptly when the signal aborts mid-sleep (the abort-event path)', async () => {
    const { _glofoxSleep } = await import('./glofox.js')
    const start = Date.now()
    await _glofoxSleep(5000, AbortSignal.timeout(20))
    expect(Date.now() - start).toBeLessThan(1000)
  })
})
