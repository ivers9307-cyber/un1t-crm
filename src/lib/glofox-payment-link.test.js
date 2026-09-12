// PAYLINK.1 — POST /v3.0/payment-links/invoices/{invoiceID} answers with the
// three integration headers + x-glofox-impersonated-member-id (verified live
// 2026-09-12 on a €209 overdue renewal). The spec's "Bearer member JWT" is
// wrong for integrators: headers alone 403, a Bearer of the api token 401.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }
const MEMBER = '679bfd4c2f6535e4f200078e'
const INVOICE = '0f187762-acc8-42d2-860c-43cbe1477df0'

const res = (status, body) => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null },
  json: async () => body, clone() { return this },
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
    expect(r).toEqual({
      ok: true, status: 200, retriable: true, invoiceId: INVOICE,
      link: `https://pay.glofox.com/payment-collector/v2/#/i/${INVOICE}`,
      amountCents: 20900, currency: 'EUR', summary: 'Month to Month Membership (7983610)', error: null,
    })
  })

  it('a non-retriable invoice is ok:true with no link (a fee, or Glofox mid-retry)', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { invoice_id: INVOICE, is_retriable: false }))
    const r = await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE })
    expect(r).toMatchObject({ ok: true, retriable: false, link: null, amountCents: null, currency: null, error: null })
  })

  it('a non-2xx is reported, never read as "no link"', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(403, { code: 'NOT_AUTHORIZED' }))
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE }))
      .toMatchObject({ ok: false, status: 403, link: null, error: 'Glofox HTTP 403' })
  })

  it('refuses bad ids locally without calling Glofox', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: 'nope', invoiceId: INVOICE })).toMatchObject({ ok: false, status: 400, error: 'INVALID_ARGS' })
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: '' })).toMatchObject({ ok: false, status: 400, error: 'INVALID_ARGS' })
    expect(await getGlofoxInvoicePaymentLink(null, { memberId: MEMBER, invoiceId: INVOICE })).toMatchObject({ ok: false, status: 400, error: 'INVALID_ARGS' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('a thrown fetch becomes ok:false with the message', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockRejectedValueOnce(new Error('socket hang up'))
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE }))
      .toMatchObject({ ok: false, status: 0, link: null, error: 'socket hang up' })
  })
})
