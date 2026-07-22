import { describe, it, expect, vi, beforeEach } from 'vitest'

const createPayment = vi.fn(async () => ({ providerRef: 'ord_1', checkoutToken: 'tok', checkoutUrl: 'https://pay/x', state: 'pending', amountCents: 2900 }))
vi.mock('./payments', () => ({ paymentsFor: () => ({ createPayment }) }))
vi.mock('./app-url', () => ({ getAppUrl: () => 'https://crm.test' }))

import { createClassBookingPayment, markClassBookingPaymentStatus } from './class-booking-payments'

function makeDb(updates) {
  return {
    from() { return this },
    update(u) { updates.push(u); return this },
    eq() { return this },
    select() { return this },
    maybeSingle: async () => ({ data: { id: 'req1' } }),
  }
}

const location = { id: 'loc1', settings: { payments: { provider: 'revolut' } } }
const request = { id: 'req1', location_id: 'loc1', customer_email: 'a@b.com', customer_name: 'A B', class_name: 'HIIT' }

beforeEach(() => { createPayment.mockClear() })

describe('createClassBookingPayment', () => {
  it('charges the server amount and persists provider refs on the row', async () => {
    const updates = []
    const res = await createClassBookingPayment({ db: makeDb(updates), request, location, amountCents: 2900, currency: 'EUR' })
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 2900, currency: 'EUR', connectedAccountId: null }))
    expect(res.checkout).toEqual(expect.objectContaining({ token: 'tok', provider: 'revolut' }))
    expect(updates.some((u) => u.payment_provider_ref === 'ord_1' && u.payment_status === 'pending')).toBe(true)
  })
})

describe('markClassBookingPaymentStatus', () => {
  const row = { id: 'req1', status: 'awaiting_payment', payment_status: 'pending' }
  it('paid → releases the booking to queued', async () => {
    const updates = []
    const r = await markClassBookingPaymentStatus({ db: makeDb(updates), request: row, providerState: 'completed', providerAmount: 2900 })
    expect(r.released).toBe(true)
    expect(updates.some((u) => u.status === 'queued' && u.payment_status === 'paid')).toBe(true)
  })
  it('failed → marks payment_status failed, does NOT queue', async () => {
    const updates = []
    const r = await markClassBookingPaymentStatus({ db: makeDb(updates), request: row, providerState: 'failed' })
    expect(r.released).toBe(false)
    expect(updates.some((u) => u.payment_status === 'failed')).toBe(true)
    expect(updates.some((u) => u.status === 'queued')).toBe(false)
  })
  it('transient state → no change', async () => {
    const updates = []
    const r = await markClassBookingPaymentStatus({ db: makeDb(updates), request: row, providerState: 'processing' })
    expect(r.released).toBe(false)
    expect(updates).toHaveLength(0)
  })
  it('already paid → idempotent no-op', async () => {
    const updates = []
    const r = await markClassBookingPaymentStatus({ db: makeDb(updates), request: { ...row, payment_status: 'paid', status: 'queued' }, providerState: 'completed' })
    expect(r.released).toBe(false)
    expect(updates).toHaveLength(0)
  })
})
