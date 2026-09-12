import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  getGlofoxInvoicePaymentLink: vi.fn(),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

const { glofoxCredentialsForLocation, getGlofoxInvoicePaymentLink } = await import('@/lib/glofox')
const { logWarn } = await import('@/lib/log')
const {
  paymentRunMetadata, capturePaymentForRun, paymentFromEnrollment, paymentCtaHtml, payAmountPhrase,
  refreshActiveRunPayment,
} = await import('./dunning-payment.js')

const INVOICE = '0f187762-acc8-42d2-860c-43cbe1477df0'
const LINK = `https://pay.glofox.com/payment-collector/v2/#/i/${INVOICE}`
const CREDS = { branchId: 'b', apiKey: 'k', apiToken: 't' }
const okResult = { ok: true, status: 200, retriable: true, link: LINK, amountCents: 20900, currency: 'EUR', summary: 'Month to Month Membership', invoiceId: INVOICE, error: null }

function dbWith(contact, { contactId = 'c1', error = null } = {}) {
  return { from(table) {
    if (table !== 'contacts') throw new Error(`unexpected table ${table}`)
    return { select(cols) {
      if (cols !== 'glofox_member_id') throw new Error(`unexpected select ${cols}`)
      return { eq(col, val) {
        if (col !== 'id' || val !== contactId) throw new Error(`unexpected eq ${col}=${val}`)
        return { maybeSingle: async () => ({ data: contact, error }) }
      } }
    } }
  } }
}

beforeEach(() => {
  vi.mocked(glofoxCredentialsForLocation).mockReset().mockResolvedValue(CREDS)
  vi.mocked(getGlofoxInvoicePaymentLink).mockReset()
  vi.mocked(logWarn).mockReset()
})

describe('paymentRunMetadata (pure)', () => {
  it('renders a payable invoice with display money', () => {
    expect(paymentRunMetadata(okResult, { invoiceId: INVOICE, now: new Date('2026-09-12T10:00:00Z') })).toEqual({
      invoice_id: INVOICE, link: LINK, link_suffix: INVOICE, amount: '€209', currency: 'EUR', retriable: true,
      fetched_at: '2026-09-12T10:00:00.000Z', error: null,
    })
  })
  it('a non-retriable or failed result keeps the invoice id and records why, with no link and no amount', () => {
    expect(paymentRunMetadata({ ...okResult, retriable: false, link: null, amountCents: null, currency: null }, { invoiceId: INVOICE }))
      .toMatchObject({ invoice_id: INVOICE, link: null, link_suffix: null, amount: '', retriable: false, error: 'not_retriable' })
    expect(paymentRunMetadata({ ok: false, status: 403, error: 'Glofox HTTP 403' }, { invoiceId: INVOICE }))
      .toMatchObject({ invoice_id: INVOICE, link: null, link_suffix: null, amount: '', retriable: false, error: 'Glofox HTTP 403' })
  })
  it('is retriable but linkless when Glofox sends no usable link', () => {
    expect(paymentRunMetadata({ ...okResult, link: null }, { invoiceId: INVOICE }))
      .toMatchObject({ retriable: true, link: null, link_suffix: null, amount: '', error: 'no_payment_link' })
  })
  it('keeps the link (and its suffix) when the amount is unknown', () => {
    expect(paymentRunMetadata({ ...okResult, amountCents: null }, { invoiceId: INVOICE }))
      .toMatchObject({ link: LINK, link_suffix: INVOICE, amount: '', error: null })
  })
  it('link_suffix is the raw last path segment, query string and all', () => {
    const link = 'https://pay.glofox.com/payment-collector/v2/#/i/abc?x=1'
    expect(paymentRunMetadata({ ...okResult, link }, { invoiceId: INVOICE }).link_suffix).toBe('abc?x=1')
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
  it('a not-ok helper result is logged', async () => {
    getGlofoxInvoicePaymentLink.mockResolvedValueOnce({ ok: false, status: 403, error: 'Glofox HTTP 403' })
    const { payment } = await capturePaymentForRun(dbWith(null), { locationId: 'loc', contactId: 'c1', invoiceId: INVOICE, glofoxUserId: '679bfd4c2f6535e4f200078e' })
    expect(payment).toMatchObject({ invoice_id: INVOICE, link: null, error: 'Glofox HTTP 403' })
    expect(logWarn).toHaveBeenCalledTimes(1)
  })
  it('contact lookup error → no Glofox call, error named, logged', async () => {
    const { payment } = await capturePaymentForRun(dbWith(null, { error: { message: 'db boom' } }), { locationId: 'loc', contactId: 'c1', invoiceId: INVOICE })
    expect(getGlofoxInvoicePaymentLink).not.toHaveBeenCalled()
    expect(payment).toMatchObject({ invoice_id: INVOICE, link: null, error: 'contact_lookup_failed' })
    expect(logWarn).toHaveBeenCalledTimes(1)
  })
  it('logs when the link suffix differs from the invoice id, not when it matches', async () => {
    getGlofoxInvoicePaymentLink.mockResolvedValueOnce(okResult)
    const matching = await capturePaymentForRun(dbWith(null), { locationId: 'loc', contactId: 'c1', invoiceId: INVOICE, glofoxUserId: '679bfd4c2f6535e4f200078e' })
    expect(matching.payment.link_suffix).toBe(INVOICE)
    expect(logWarn).not.toHaveBeenCalled()

    const otherInvoice = '11111111-1111-1111-1111-111111111111'
    getGlofoxInvoicePaymentLink.mockResolvedValueOnce({ ...okResult, link: `https://pay.glofox.com/payment-collector/v2/#/i/${otherInvoice}` })
    const { payment } = await capturePaymentForRun(dbWith(null), { locationId: 'loc', contactId: 'c1', invoiceId: INVOICE, glofoxUserId: '679bfd4c2f6535e4f200078e' })
    expect(payment.link_suffix).toBe(otherInvoice)
    expect(logWarn).toHaveBeenCalledWith('dunning-payment', 'pay link suffix differs from invoice id', { invoiceId: INVOICE, suffix: otherInvoice })
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
    expect(paymentCtaHtml({ ...payment, link: 'javascript:alert(1)' })).toBe('update your card in the Glofox app')
    expect(paymentCtaHtml(null)).toBe('update your card in the Glofox app')
  })
  it('the amount phrase has a leading space and is empty when unknown', () => {
    expect(payAmountPhrase(payment)).toBe(' of €209')
    expect(payAmountPhrase({ ...payment, amount: '' })).toBe('')
    expect(payAmountPhrase(null)).toBe('')
  })
})

describe('refreshActiveRunPayment (IO, never throws)', () => {
  const NEW_PAYMENT = { invoice_id: 'NEW', link: 'https://pay.test/NEW', link_suffix: 'NEW', amount: '€209', currency: 'EUR', retriable: true, fetched_at: 'x', error: null }

  function dbForRefresh({ row = null, readError = null, updateData = [{ id: 'e1' }], updateError = null, readThrows = false } = {}) {
    const updateCalls = []
    const readFilters = []
    return {
      updateCalls,
      readFilters,
      from(table) {
        if (table !== 'sequence_enrollments') throw new Error(`unexpected table ${table}`)
        return {
          select(cols) {
            if (cols !== 'id, metadata') throw new Error(`unexpected select ${cols}`)
            return { eq(col1, val1) {
              readFilters.push([col1, val1])
              return { eq(col2, val2) {
                readFilters.push([col2, val2])
                return { eq(col3, val3) {
                  readFilters.push([col3, val3])
                  return { order() {
                    return { limit() {
                      return { maybeSingle: async () => {
                        if (readThrows) throw new Error('read boom')
                        return { data: row, error: readError }
                      } }
                    } }
                  } }
                } }
              } }
            } }
          },
          update(values) {
            return { eq(idCol, idVal) {
              return { eq(statusCol, statusVal) {
                updateCalls.push({ values, filters: { [idCol]: idVal, [statusCol]: statusVal } })
                return { select: async () => ({ data: updateError ? null : updateData, error: updateError }) }
              } }
            } }
          },
        }
      },
    }
  }

  it('writes payment onto the active row, filtered on id + status, preserving other metadata', async () => {
    const db = dbForRefresh({ row: { id: 'e1', metadata: { previous_runs: [1], payment: { invoice_id: 'OLD' } } } })
    const out = await refreshActiveRunPayment(db, { sequenceId: 'seq1', contactId: 'c1', payment: NEW_PAYMENT })
    expect(out).toEqual({ refreshed: 1 })
    expect(db.readFilters).toEqual([['sequence_id', 'seq1'], ['contact_id', 'c1'], ['status', 'active']])
    expect(db.updateCalls).toHaveLength(1)
    expect(db.updateCalls[0].values).toEqual({ metadata: { previous_runs: [1], payment: NEW_PAYMENT } })
    expect(db.updateCalls[0].filters).toEqual({ id: 'e1', status: 'active' })
  })

  it('PAYLINK.4b — does not downgrade a live link: same invoice, new link falsy → kept, no update', async () => {
    const db = dbForRefresh({ row: { id: 'e1', metadata: { payment: { invoice_id: 'SAME', link: 'https://pay.test/SAME' } } } })
    const noLinkPayment = { invoice_id: 'SAME', link: null, link_suffix: null, amount: '', error: 'not_retriable' }
    const out = await refreshActiveRunPayment(db, { sequenceId: 'seq1', contactId: 'c1', payment: noLinkPayment })
    expect(out).toEqual({ refreshed: 0, reason: 'kept_existing_link' })
    expect(db.updateCalls).toHaveLength(0)
  })

  it('PAYLINK.4b — still overwrites when the invoice id differs, even with a falsy new link', async () => {
    const db = dbForRefresh({ row: { id: 'e1', metadata: { payment: { invoice_id: 'OLD', link: 'https://pay.test/OLD' } } } })
    const noLinkPayment = { invoice_id: 'NEW2', link: null, link_suffix: null, amount: '', error: 'not_retriable' }
    const out = await refreshActiveRunPayment(db, { sequenceId: 'seq1', contactId: 'c1', payment: noLinkPayment })
    expect(out).toEqual({ refreshed: 1 })
    expect(db.updateCalls).toHaveLength(1)
    expect(db.updateCalls[0].values).toEqual({ metadata: { payment: noLinkPayment } })
  })

  it('PAYLINK.5b — a no-invoice payment (e.g. a slipping click with nothing PAST_DUE) never downgrades a live run\'s link', async () => {
    const db = dbForRefresh({ row: { id: 'e1', metadata: { payment: { invoice_id: 'inv-A', link: 'https://pay.test/inv-A' } } } })
    const noInvoicePayment = { invoice_id: null, link: null, link_suffix: null, amount: '', error: 'no_invoice_id' }
    const out = await refreshActiveRunPayment(db, { sequenceId: 'seq1', contactId: 'c1', payment: noInvoicePayment })
    expect(out).toEqual({ refreshed: 0, reason: 'kept_existing_link' })
    expect(db.updateCalls).toHaveLength(0)
  })

  it('no active row → { refreshed: 0 }, no update call', async () => {
    const db = dbForRefresh({ row: null })
    const out = await refreshActiveRunPayment(db, { sequenceId: 'seq1', contactId: 'c1', payment: NEW_PAYMENT })
    expect(out).toEqual({ refreshed: 0 })
    expect(db.updateCalls).toHaveLength(0)
  })

  it('update error → { refreshed: 0 }, logWarn called once', async () => {
    const db = dbForRefresh({ row: { id: 'e1', metadata: {} }, updateError: { message: 'db boom' } })
    const out = await refreshActiveRunPayment(db, { sequenceId: 'seq1', contactId: 'c1', payment: NEW_PAYMENT })
    expect(out).toEqual({ refreshed: 0 })
    expect(logWarn).toHaveBeenCalledTimes(1)
  })

  it('missing args → { refreshed: 0 }, db.from never called', async () => {
    const db = dbForRefresh()
    const fromSpy = vi.spyOn(db, 'from')
    expect(await refreshActiveRunPayment(db, {})).toEqual({ refreshed: 0 })
    expect(fromSpy).not.toHaveBeenCalled()
  })

  it('a read that throws → { refreshed: 0 }, logWarn called', async () => {
    const db = dbForRefresh({ readThrows: true })
    const out = await refreshActiveRunPayment(db, { sequenceId: 'seq1', contactId: 'c1', payment: NEW_PAYMENT })
    expect(out).toEqual({ refreshed: 0 })
    expect(logWarn).toHaveBeenCalled()
  })
})
