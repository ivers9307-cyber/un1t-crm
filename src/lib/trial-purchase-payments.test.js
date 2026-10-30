// PAIDTRIAL.1 — the payment state machine releases a row exactly once and
// never moves a settled or terminal row.
import { describe, it, expect, vi } from 'vitest'

const createPayment = vi.fn(async () => ({ providerRef: 'ord_1', checkoutToken: 'tok', checkoutUrl: 'https://pay/x' }))
vi.mock('./payments', () => ({ paymentsFor: () => ({ createPayment }) }))
vi.mock('./tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://crm.test') }))
vi.mock('./location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T Stillorgan' })) }))

import { markTrialPurchasePaymentStatus, trialPurchaseDescription, createTrialPurchasePayment } from './trial-purchase-payments'

function db() {
  const calls = []
  const client = {
    from: (table) => ({
      update: (fields) => ({
        eq: (col, val) => { calls.push({ table, fields, col, val }); return Promise.resolve({ error: null }) },
      }),
    }),
  }
  return { client, calls }
}

describe('markTrialPurchasePaymentStatus', () => {
  it('completed on an awaiting_payment row → paid + queued, released once', async () => {
    const { client, calls } = db()
    const purchase = { id: 'p1', status: 'awaiting_payment', payment_status: 'pending', amount_cents: 3900 }
    const r = await markTrialPurchasePaymentStatus({ db: client, purchase, providerState: 'COMPLETED', providerAmount: 3900, now: () => 'T' })
    expect(r).toEqual({ released: true })
    expect(calls[0].fields).toEqual({ payment_status: 'paid', paid_at: 'T', status: 'queued' })
  })
  it('a paid row is never touched again (webhook redelivery)', async () => {
    const { client, calls } = db()
    const r = await markTrialPurchasePaymentStatus({ db: client, purchase: { id: 'p1', status: 'queued', payment_status: 'paid' }, providerState: 'completed' })
    expect(r).toEqual({ released: false })
    expect(calls).toHaveLength(0)
  })
  it('records a different settled amount and keeps a non-awaiting status where it is', async () => {
    const { client, calls } = db()
    const r = await markTrialPurchasePaymentStatus({ db: client, purchase: { id: 'p1', status: 'processing', payment_status: 'pending', amount_cents: 3900 }, providerState: 'completed', providerAmount: 3500, now: () => 'T' })
    expect(r).toEqual({ released: false })
    expect(calls[0].fields).toEqual({ payment_status: 'paid', paid_at: 'T', amount_cents: 3500 })
  })
  it('failed, cancelled and expired are terminal: payment_failed, no release', async () => {
    for (const [state, expected] of [['failed', 'failed'], ['cancelled', 'expired'], ['expired', 'expired']]) {
      const { client, calls } = db()
      const r = await markTrialPurchasePaymentStatus({ db: client, purchase: { id: 'p1', status: 'awaiting_payment', payment_status: 'pending' }, providerState: state })
      expect(r).toEqual({ released: false })
      expect(calls[0].fields).toEqual({ payment_status: expected, status: 'payment_failed' })
    }
  })
  it('a transient state changes nothing', async () => {
    const { client, calls } = db()
    const r = await markTrialPurchasePaymentStatus({ db: client, purchase: { id: 'p1', status: 'awaiting_payment', payment_status: 'pending' }, providerState: 'authorised' })
    expect(r).toEqual({ released: false })
    expect(calls).toHaveLength(0)
  })
  it('a failed write throws rather than reporting a release', async () => {
    const client = { from: () => ({ update: () => ({ eq: async () => ({ error: new Error('db down') }) }) }) }
    await expect(markTrialPurchasePaymentStatus({ db: client, purchase: { id: 'p1', status: 'awaiting_payment', payment_status: 'pending' }, providerState: 'completed' })).rejects.toThrow('db down')
  })
})

describe('trialPurchaseDescription', () => {
  it('names the studio brand and the product, no dash', () => {
    expect(trialPurchaseDescription('UN1T Stillorgan', '2 Week Trial')).toBe('UN1T Stillorgan: 2 Week Trial')
    expect(trialPurchaseDescription('', '2 Week Trial')).toBe('2 Week Trial')
  })
})

describe('createTrialPurchasePayment (REVPAY.7)', () => {
  it('the order carries the buyer, trial:<id> and a TRIAL suffix, on the default expiry', async () => {
    const client = { from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }) }
    const purchase = { id: 'tp1', location_id: 'loc1', product_name: '2 Week Trial', customer_email: 'a@b.com', customer_name: 'A B' }
    await createTrialPurchasePayment({ db: client, purchase, location: { id: 'loc1', settings: {} }, amountCents: 3900, currency: 'EUR' })
    const args = createPayment.mock.calls[0][0]
    expect(args).toEqual(expect.objectContaining({
      customer: { email: 'a@b.com', fullName: 'A B' },
      merchantReference: 'trial:tp1',
      statementDescriptorSuffix: 'TRIAL',
      idempotencyKey: 'tp1',
    }))
    expect('expirePendingAfter' in args).toBe(false)
  })
  it('a returnPath sends the buyer back to the page they started on', async () => {
    createPayment.mockClear()
    const client = { from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }) }
    const purchase = { id: 'tp2', location_id: 'loc1', product_name: '2 Week Trial', customer_email: 'a@b.com', customer_name: 'A B' }
    await createTrialPurchasePayment({ db: client, purchase, location: { id: 'loc1', settings: {} }, amountCents: 3900, currency: 'EUR', returnPath: '/stillorgan' })
    expect(createPayment.mock.calls[0][0].returnUrl).toBe(`https://crm.test/stillorgan?purchase=${purchase.id}`)
  })
})
