import { describe, it, expect } from 'vitest'
import { analyzeReportShape } from './glofox-report-shape'

// A real row pasted from the live Glofox /Analytics/report (TransactionsList) —
// a FAILED subscription charge. Note amount: 0 even though the underlying
// invoice is non-zero (b847cdac is €1,144 PAST_DUE in glofox_invoices). That
// gap is the entire reason for this probe.
const LIAM_FAILED = {
  StripeCharge: {
    id: '169150657',
    transaction_status: 'ERROR',
    metadata: {
      glofox_event: 'subscription_payment_failed',
      user_id: '69307f4c1dd65425e70318bb',
      user_name: 'Liam Higgins',
      payment_method: 'credit_card',
    },
    amount: 0,
    currency: 'eur',
    paid: false,
    invoice_id: 'b847cdac-33fb-458c-858b-d842f7fc113b',
    created: '2026-06-14 17:27:51',
    description: '5) Black Friday 6 Month Unlimited',
  },
}

const STRIPE_PAID = {
  StripeCharge: {
    id: '169150999',
    transaction_status: 'SUCCESS',
    metadata: { glofox_event: 'subscription_payment_succeeded', user_id: 'abc' },
    amount: 20900,
    currency: 'eur',
    paid: true,
    invoice_id: '11111111-1111-1111-1111-111111111111',
    created: '2026-03-22 10:00:00',
  },
}

const INVOICE_ROW = {
  Invoice: {
    id: 'inv-1',
    amount: 5000,
    paid: false,
    invoice_id: '22222222-2222-2222-2222-222222222222',
  },
}

describe('analyzeReportShape', () => {
  it('groups rows by transaction-envelope type and counts amount population', () => {
    const out = analyzeReportShape([LIAM_FAILED, STRIPE_PAID, INVOICE_ROW])

    expect(out.total).toBe(3)

    const sc = out.byType.StripeCharge
    expect(sc.count).toBe(2)
    expect(sc.amount.populated).toBe(1) // only the €209 paid one
    expect(sc.amount.zero).toBe(1) // the failed one
    expect(sc.amount.max).toBe(20900)
    expect(sc.status).toEqual({ ERROR: 1, SUCCESS: 1 })
    expect(sc.paid).toEqual({ true: 1, false: 1, missing: 0 })

    expect(out.byType.Invoice.count).toBe(1)

    // The union of fields seen on the inner object — so we can spot any
    // amount-bearing field other than `amount`.
    expect(sc.fields).toContain('invoice_id')
    expect(sc.fields).toContain('amount')
  })

  it('dumps every row matching probe_invoice_id, fully unwrapped', () => {
    const out = analyzeReportShape([LIAM_FAILED, STRIPE_PAID], {
      probeInvoiceId: 'b847cdac-33fb-458c-858b-d842f7fc113b',
    })
    expect(out.probe.invoiceId).toBe('b847cdac-33fb-458c-858b-d842f7fc113b')
    expect(out.probe.matches).toHaveLength(1)
    expect(out.probe.matches[0].type).toBe('StripeCharge')
    expect(out.probe.matches[0].inner.amount).toBe(0)
    expect(out.probe.matches[0].inner.description).toContain('Black Friday')
  })

  it('handles flat (non-enveloped) rows without throwing', () => {
    const flat = { invoice_id: 'x', amount: 100, paid: true, transaction_status: 'SUCCESS' }
    const out = analyzeReportShape([flat])
    expect(out.total).toBe(1)
    expect(out.byType['(flat)'].count).toBe(1)
    expect(out.byType['(flat)'].amount.populated).toBe(1)
  })
})
