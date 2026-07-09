// Stripe Connect refund adapter (EVENTS-HOST.7). Refunds attach to the
// PaymentIntent on the HOST's connected account; the full-refund path also
// returns UN1T's booking fee via refund_application_fee. getStripe is mocked
// so these assert the exact Stripe call shape without a network round-trip.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { retrieve, create, sessionsCreate } = vi.hoisted(() => ({
  retrieve: vi.fn(), create: vi.fn(), sessionsCreate: vi.fn(),
}))

vi.mock('../stripe', () => ({
  getStripe: () => ({
    checkout: { sessions: { retrieve, create: sessionsCreate } },
    refunds: { create },
  }),
}))

const { refundPayment, createPayment } = await import('./stripe-connect.js')

beforeEach(() => {
  retrieve.mockReset()
  create.mockReset()
  sessionsCreate.mockReset()
  retrieve.mockResolvedValue({ id: 'cs_1', payment_intent: 'pi_123' })
  create.mockResolvedValue({ id: 're_456' })
  sessionsCreate.mockResolvedValue({ id: 'cs_new', client_secret: 'cs_new_secret', url: 'https://hosted.example/x' })
})

describe('stripe-connect createPayment (embedded checkout)', () => {
  const base = {
    amountCents: 4700, currency: 'EUR', description: 'Test Race — race entry',
    returnUrl: 'https://crm.test/event/x/confirmed?registration=r1',
    cancelUrl: 'https://crm.test/event/x', metadata: { race_registration_id: 'r1' },
    connectedAccountId: 'acct_host', applicationFeeCents: 200,
  }

  it('requires the connected account id (fails before any Stripe call)', async () => {
    await expect(createPayment({ ...base, connectedAccountId: null })).rejects.toThrow(/connected account/)
    expect(sessionsCreate).not.toHaveBeenCalled()
  })

  it('creates an EMBEDDED session (ui_mode) and returns the client secret, not a hosted url', async () => {
    const res = await createPayment(base)
    const [params, opts] = sessionsCreate.mock.calls[0]
    // Embedded, not hosted redirect.
    expect(params.ui_mode).toBe('embedded_page')
    expect(params.return_url).toBe(base.returnUrl)
    expect(params.redirect_on_completion).toBe('if_required')
    // Hosted-only fields must be ABSENT (Stripe rejects them in embedded mode).
    expect(params.success_url).toBeUndefined()
    expect(params.cancel_url).toBeUndefined()
    // Direct charge on the host account with UN1T's booking fee skimmed.
    expect(opts).toEqual({ stripeAccount: 'acct_host' })
    expect(params.payment_intent_data).toEqual({ application_fee_amount: 200 })
    // Two line items: ticket portion (amount − fee) + the booking fee.
    expect(params.line_items[0].price_data.unit_amount).toBe(4500)
    expect(params.line_items[1].price_data.unit_amount).toBe(200)
    // The buyer renders the widget against the client secret; no url.
    expect(res).toEqual({
      providerRef: 'cs_new',
      checkoutToken: 'cs_new_secret',
      checkoutUrl: null,
      state: 'pending',
      amountCents: 4700,
    })
  })

  it('omits the application fee entirely when it is 0', async () => {
    await createPayment({ ...base, applicationFeeCents: 0 })
    const [params] = sessionsCreate.mock.calls[0]
    expect(params.payment_intent_data).toBeUndefined()
    expect(params.line_items).toHaveLength(1)
    expect(params.line_items[0].price_data.unit_amount).toBe(4700)
  })
})

describe('stripe-connect refundPayment', () => {
  it('requires the connected account id (fails before any Stripe call)', async () => {
    await expect(refundPayment('cs_1', { amountCents: 500 })).rejects.toThrow(/connected account/)
    expect(retrieve).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('refunds the PaymentIntent on the connected account and returns the refund id', async () => {
    const res = await refundPayment('cs_1', {
      amountCents: 4500,
      connectedAccountId: 'acct_host',
      idempotencyKey: 'refund:o1:4500',
    })
    expect(retrieve).toHaveBeenCalledWith('cs_1', { stripeAccount: 'acct_host' })
    expect(create).toHaveBeenCalledTimes(1)
    const [params, opts] = create.mock.calls[0]
    expect(params.payment_intent).toBe('pi_123')
    expect(params.amount).toBe(4500)
    // partial-style refund: the booking fee is retained (no refund_application_fee)
    expect(params.refund_application_fee).toBeUndefined()
    expect(opts).toEqual({ stripeAccount: 'acct_host', idempotencyKey: 'refund:o1:4500' })
    expect(res).toEqual({ refundId: 're_456' })
  })

  it('on a full refund also returns UN1T’s booking fee (refund_application_fee)', async () => {
    await refundPayment('cs_1', { amountCents: 4700, connectedAccountId: 'acct_host', refundApplicationFee: true })
    const [params] = create.mock.calls[0]
    expect(params.refund_application_fee).toBe(true)
  })

  it('throws when the session has no payment_intent (not paid) — no refund attempted', async () => {
    retrieve.mockResolvedValue({ id: 'cs_1', payment_intent: null })
    await expect(refundPayment('cs_1', { amountCents: 500, connectedAccountId: 'acct_host' }))
      .rejects.toThrow(/payment_intent/)
    expect(create).not.toHaveBeenCalled()
  })

  it('omits amount when amountCents is 0/absent (Stripe refunds the full remaining charge)', async () => {
    await refundPayment('cs_1', { connectedAccountId: 'acct_host' })
    const [params] = create.mock.calls[0]
    expect(params.amount).toBeUndefined()
  })
})
