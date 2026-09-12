import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  getGlofoxInvoicePaymentLink: vi.fn(),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

const { glofoxCredentialsForLocation, getGlofoxInvoicePaymentLink } = await import('@/lib/glofox')
const {
  paymentRunMetadata, capturePaymentForRun, paymentFromEnrollment, paymentCtaHtml, payAmountPhrase,
} = await import('./dunning-payment.js')

const INVOICE = '0f187762-acc8-42d2-860c-43cbe1477df0'
const LINK = `https://pay.glofox.com/payment-collector/v2/#/i/${INVOICE}`
const CREDS = { branchId: 'b', apiKey: 'k', apiToken: 't' }
const okResult = { ok: true, status: 200, retriable: true, link: LINK, amountCents: 20900, currency: 'EUR', summary: 'Month to Month Membership', invoiceId: INVOICE, error: null }

function dbWith(contact) {
  return { from(table) {
    if (table !== 'contacts') throw new Error(`unexpected table ${table}`)
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: contact, error: null }) }) }) }
  } }
}

beforeEach(() => {
  vi.mocked(glofoxCredentialsForLocation).mockReset().mockResolvedValue(CREDS)
  vi.mocked(getGlofoxInvoicePaymentLink).mockReset()
})

describe('paymentRunMetadata (pure)', () => {
  it('renders a payable invoice with display money', () => {
    expect(paymentRunMetadata(okResult, { invoiceId: INVOICE, now: new Date('2026-09-12T10:00:00Z') })).toEqual({
      invoice_id: INVOICE, link: LINK, amount: '€209', currency: 'EUR', retriable: true,
      fetched_at: '2026-09-12T10:00:00.000Z', error: null,
    })
  })
  it('a non-retriable or failed result keeps the invoice id and records why, with no link and no amount', () => {
    expect(paymentRunMetadata({ ...okResult, retriable: false, link: null, amountCents: null, currency: null }, { invoiceId: INVOICE }))
      .toMatchObject({ invoice_id: INVOICE, link: null, amount: '', retriable: false, error: 'not_retriable' })
    expect(paymentRunMetadata({ ok: false, status: 403, error: 'Glofox HTTP 403' }, { invoiceId: INVOICE }))
      .toMatchObject({ invoice_id: INVOICE, link: null, amount: '', retriable: false, error: 'Glofox HTTP 403' })
  })
})

describe('capturePaymentForRun (IO, never throws)', () => {
  it('uses the given member id and returns the payment', async () => {
    getGlofoxInvoicePaymentLink.mockResolvedValueOnce(okResult)
    const { payment } = await capturePaymentForRun(dbWith(null), { locationId: 'loc', contactId: 'c1', invoiceId: INVOICE, glofoxUserId: '679bfd4c2f6535e4f200078e' })
    expect(getGlofoxInvoicePaymentLink).toHaveBeenCalledWith(CREDS, { memberId: '679bfd4c2f6535e4f200078e', invoiceId: INVOICE })
    expect(payment).toMatchObject({ invoice_id: INVOICE, link: LINK, amount: '€209' })
  })
  it('falls back to the contact\'s linked Glofox id when none is given', async () => {
    getGlofoxInvoicePaymentLink.mockResolvedValueOnce(okResult)
    await capturePaymentForRun(dbWith({ glofox_member_id: '679bfd4c2f6535e4f200078e' }), { locationId: 'loc', contactId: 'c1', invoiceId: INVOICE })
    expect(getGlofoxInvoicePaymentLink).toHaveBeenCalledWith(CREDS, { memberId: '679bfd4c2f6535e4f200078e', invoiceId: INVOICE })
  })
  it('no member id → no call, payment without link, error named', async () => {
    const { payment } = await capturePaymentForRun(dbWith({ glofox_member_id: null }), { locationId: 'loc', contactId: 'c1', invoiceId: INVOICE })
    expect(getGlofoxInvoicePaymentLink).not.toHaveBeenCalled()
    expect(payment).toMatchObject({ invoice_id: INVOICE, link: null, error: 'no_glofox_member_id' })
  })
  it('no credentials → no call, error named', async () => {
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null })
    const { payment } = await capturePaymentForRun(dbWith(null), { locationId: 'loc', contactId: 'c1', invoiceId: INVOICE, glofoxUserId: '679bfd4c2f6535e4f200078e' })
    expect(payment).toMatchObject({ invoice_id: INVOICE, link: null, error: 'no_glofox_credentials' })
  })
  it('no invoice id → payment with error, nothing called', async () => {
    const { payment } = await capturePaymentForRun(dbWith(null), { locationId: 'loc', contactId: 'c1', invoiceId: null })
    expect(payment).toMatchObject({ invoice_id: null, link: null, error: 'no_invoice_id' })
  })
  it('a helper that throws still yields a payment (error = message)', async () => {
    getGlofoxInvoicePaymentLink.mockRejectedValueOnce(new Error('boom'))
    const { payment } = await capturePaymentForRun(dbWith(null), { locationId: 'loc', contactId: 'c1', invoiceId: INVOICE, glofoxUserId: '679bfd4c2f6535e4f200078e' })
    expect(payment).toMatchObject({ invoice_id: INVOICE, link: null, error: 'boom' })
  })
})

describe('paymentFromEnrollment / email fragments (pure)', () => {
  const payment = { invoice_id: INVOICE, link: LINK, amount: '€209', currency: 'EUR', retriable: true, fetched_at: 'x', error: null }
  it('reads metadata.payment and tolerates every missing shape', () => {
    expect(paymentFromEnrollment({ metadata: { payment } })).toEqual(payment)
    expect(paymentFromEnrollment({ metadata: {} })).toBeNull()
    expect(paymentFromEnrollment({ metadata: null })).toBeNull()
    expect(paymentFromEnrollment(null)).toBeNull()
    expect(paymentFromEnrollment({ metadata: { payment: 'junk' } })).toBeNull()
  })
  it('the CTA fragment carries an escaped link when there is one, else the card-update wording', () => {
    expect(paymentCtaHtml(payment)).toBe(`<a href="${LINK}">pay it now here</a>, it takes a few seconds, or update your card in the Glofox app`)
    expect(paymentCtaHtml({ ...payment, link: 'https://x.test/?a=1&b="2"' })).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"')
    expect(paymentCtaHtml({ ...payment, link: null })).toBe('update your card in the Glofox app')
    expect(paymentCtaHtml(null)).toBe('update your card in the Glofox app')
  })
  it('the amount phrase has a leading space and is empty when unknown', () => {
    expect(payAmountPhrase(payment)).toBe(' of €209')
    expect(payAmountPhrase({ ...payment, amount: '' })).toBe('')
    expect(payAmountPhrase(null)).toBe('')
  })
})
