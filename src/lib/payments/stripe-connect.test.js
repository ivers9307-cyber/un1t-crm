// Stripe Connect refund adapter (EVENTS-HOST.7). Refunds attach to the
// PaymentIntent on the HOST's connected account; the full-refund path also
// returns UN1T's booking fee via refund_application_fee. getStripe is mocked
// so these assert the exact Stripe call shape without a network round-trip.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { retrieve, create } = vi.hoisted(() => ({ retrieve: vi.fn(), create: vi.fn() }))

vi.mock('../stripe', () => ({
  getStripe: () => ({
    checkout: { sessions: { retrieve } },
    refunds: { create },
  }),
}))

const { refundPayment } = await import('./stripe-connect.js')

beforeEach(() => {
  retrieve.mockReset()
  create.mockReset()
  retrieve.mockResolvedValue({ id: 'cs_1', payment_intent: 'pi_123' })
  create.mockResolvedValue({ id: 're_456' })
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
