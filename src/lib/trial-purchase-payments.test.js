// PAIDTRIAL.1 — the payment state machine releases a row exactly once and
// never moves a settled or terminal row.
import { describe, it, expect } from 'vitest'
import { markTrialPurchasePaymentStatus, trialPurchaseDescription } from './trial-purchase-payments'

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
