// PAIDTRIAL.1 — the payment state machine releases a row exactly once and
// never moves a settled or terminal row.
import { describe, it, expect, vi } from 'vitest'

const createPayment = vi.fn(async () => ({ providerRef: 'ord_1', checkoutToken: 'tok', checkoutUrl: 'https://pay/x' }))
vi.mock('./payments', () => ({ paymentsFor: () => ({ createPayment }) }))
vi.mock('./tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://crm.test') }))
vi.mock('./location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T Stillorgan' })) }))

import { markTrialPurchasePaymentStatus, trialPurchaseDescription, createTrialPurchasePayment, findReusableTrialCheckout } from './trial-purchase-payments'
import { TRIAL_CHECKOUT_REUSE_MS } from './trial-checkout-window'

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
  it('failed, cancelled and expired are terminal: payment_failed, no release, and the row says which it was (TRIALLEAK.1)', async () => {
    const NOW = '2026-11-14T12:00:00.000Z'
    const created_at = '2026-11-14T11:50:00.000Z' // ten minutes old: inside the order's two hours
    for (const [state, expected, reason] of [['failed', 'failed', 'payment_declined'], ['cancelled', 'expired', 'checkout_cancelled'], ['expired', 'expired', 'checkout_expired']]) {
      const { client, calls } = db()
      const r = await markTrialPurchasePaymentStatus({ db: client, purchase: { id: 'p1', status: 'awaiting_payment', payment_status: 'pending', created_at }, providerState: state, now: () => NOW })
      expect(r).toEqual({ released: false })
      expect(calls[0].fields).toEqual({ payment_status: expected, status: 'payment_failed', last_error: reason })
    }
  })
  it('TRIALLEAK.1: a failed order whose two hours are up is recorded as an expiry, not a refusal', async () => {
    const { client, calls } = db()
    await markTrialPurchasePaymentStatus({
      db: client, providerState: 'failed', now: () => '2026-11-14T12:00:00.000Z',
      purchase: { id: 'p1', status: 'awaiting_payment', payment_status: 'pending', created_at: '2026-11-14T10:00:00.000Z' },
    })
    expect(calls[0].fields).toEqual({ payment_status: 'expired', status: 'payment_failed', last_error: 'checkout_expired' })
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
  it('the order carries the buyer, trial:<id> and a TRIAL suffix, and stays payable for two hours (TRIALLEAK.1)', async () => {
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
    expect(args.expirePendingAfter).toBe('PT2H')
  })
  it('a returnPath sends the buyer back to the page they started on', async () => {
    createPayment.mockClear()
    const client = { from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }) }
    const purchase = { id: 'tp2', location_id: 'loc1', product_name: '2 Week Trial', customer_email: 'a@b.com', customer_name: 'A B' }
    await createTrialPurchasePayment({ db: client, purchase, location: { id: 'loc1', settings: {} }, amountCents: 3900, currency: 'EUR', returnPath: '/stillorgan' })
    expect(createPayment.mock.calls[0][0].returnUrl).toBe(`https://crm.test/stillorgan?purchase=${purchase.id}`)
  })
})

describe('findReusableTrialCheckout (TRIALLEAK.1)', () => {
  const NOW = Date.parse('2026-11-14T12:00:00.000Z')
  const ARGS = { purchaseId: 'tp1', contactId: 'c1', locationId: 'loc1', landingPath: 'stillorgan', pageId: null, membershipId: 'm1', planCode: 'p1', amountCents: 3900, currency: 'EUR', nowMs: NOW }
  const OPEN = { id: 'tp1', contact_id: 'c1', status: 'awaiting_payment', payment_status: 'pending', payment_provider: 'revolut', payment_checkout_token: 'tok', created_at: '2026-11-14T11:30:00.000Z' }
  function reader(answer) {
    const filters = []
    const b = { select: () => b, maybeSingle: async () => answer }
    for (const op of ['eq', 'is', 'gte']) b[op] = (...a) => { filters.push([op, ...a]); return b }
    return { client: { from: (t) => { filters.push(['from', t]); return b } }, filters }
  }
  const has = (filters, ...f) => filters.some((x) => JSON.stringify(x) === JSON.stringify(f))

  it("hands back the open Revolut checkout the caller NAMES, and only as this contact's, at this studio, page, product and price, inside the window", async () => {
    const { client, filters } = reader({ data: OPEN, error: null })
    expect(await findReusableTrialCheckout(client, ARGS)).toEqual({ row: OPEN, error: null })
    expect(has(filters, 'from', 'trial_purchases')).toBe(true)
    for (const f of [
      ['eq', 'id', 'tp1'], ['eq', 'contact_id', 'c1'], ['eq', 'location_id', 'loc1'], ['eq', 'landing_path', 'stillorgan'],
      ['eq', 'status', 'awaiting_payment'], ['eq', 'payment_status', 'pending'], ['eq', 'payment_provider', 'revolut'],
      ['eq', 'membership_id', 'm1'], ['eq', 'plan_code', 'p1'], ['eq', 'amount_cents', 3900], ['eq', 'currency', 'EUR'],
      ['is', 'page_id', null], ['gte', 'created_at', new Date(NOW - TRIAL_CHECKOUT_REUSE_MS).toISOString()],
    ]) expect(has(filters, ...f), JSON.stringify(f)).toBe(true)
  })
  it('a page purchase is matched on its page', async () => {
    const { client, filters } = reader({ data: null, error: null })
    await findReusableTrialCheckout(client, { ...ARGS, pageId: 'pg1' })
    expect(has(filters, 'eq', 'page_id', 'pg1')).toBe(true)
    expect(filters.some((f) => f[0] === 'is')).toBe(false)
  })
  it('nothing open is none; a row with no token or past the window is none', async () => {
    expect(await findReusableTrialCheckout(reader({ data: null, error: null }).client, ARGS)).toEqual({ row: null, error: null })
    expect((await findReusableTrialCheckout(reader({ data: { ...OPEN, payment_checkout_token: null }, error: null }).client, ARGS)).row).toBeNull()
    expect((await findReusableTrialCheckout(reader({ data: { ...OPEN, created_at: '2026-11-14T09:00:00.000Z' }, error: null }).client, ARGS)).row).toBeNull()
  })
  it('a failed read is reported, never a row', async () => {
    const error = { code: '57014' }
    expect(await findReusableTrialCheckout(reader({ data: null, error }).client, ARGS)).toEqual({ row: null, error })
  })
  it('no purchase id (an email or phone alone), no contact or no studio asks nothing and finds nothing', async () => {
    const { client, filters } = reader({ data: OPEN, error: null })
    for (const missing of ['purchaseId', 'contactId', 'locationId']) {
      expect(await findReusableTrialCheckout(client, { ...ARGS, [missing]: null })).toEqual({ row: null, error: null })
    }
    expect(await findReusableTrialCheckout(client, { ...ARGS, purchaseId: undefined })).toEqual({ row: null, error: null })
    expect(filters).toHaveLength(0)
  })
  it("a row that is not the named id, or not this contact's, is never returned even if the database answered with it", async () => {
    expect((await findReusableTrialCheckout(reader({ data: { ...OPEN, id: 'tp-other' }, error: null }).client, ARGS)).row).toBeNull()
    expect((await findReusableTrialCheckout(reader({ data: { ...OPEN, contact_id: 'c2' }, error: null }).client, ARGS)).row).toBeNull()
  })
})
