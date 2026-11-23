// SALEALERT.1 — the class-booking status poll rings the sale push only when its
// own re-check wins the paid transition (released), and never leaks the buyer
// columns it reads for that push.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ alert: vi.fn(async () => ({ sent: true })), rateLimit: vi.fn(), getPayment: vi.fn(), mark: vi.fn(), publish: vi.fn(async () => {}), row: null }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.rateLimit }))
vi.mock('@/lib/payments', () => ({ paymentsFor: () => ({ getPayment: mocks.getPayment }) }))
vi.mock('@/lib/class-booking-payments', () => ({ markClassBookingPaymentStatus: mocks.mark }))
vi.mock('@/lib/qstash', () => ({ publishClassBookingJob: mocks.publish }))
vi.mock('@/lib/sale-alert-sources', () => ({ alertClassBookingSale: mocks.alert }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: mocks.row, error: null }) }
      return b
    },
  }),
}))

import { GET } from './route'

const call = (id) => GET(new Request(`http://x/api/public/class-booking-payments/${id}`), { params: Promise.resolve({ id }) })
const ROW = {
  id: 'cb1', status: 'awaiting_payment', payment_status: 'pending', payment_provider: 'revolut', payment_provider_ref: 'ord1',
  payment_checkout_token: 'tok', payment_checkout_url: null, amount_cents: 1500, currency: 'EUR', class_name: 'Hatch Strength',
  connected_account_id: null, location_id: 'loc-1', contact_id: 'contact-uuid-1', customer_name: 'Sam Byrne',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.row = ROW
  mocks.rateLimit.mockResolvedValue({ allowed: true })
  mocks.getPayment.mockResolvedValue({ state: 'completed', amountCents: 1500 })
  mocks.mark.mockResolvedValue({ released: true })
})

describe('GET /api/public/class-booking-payments/[id] — sale push', () => {
  it('a re-check that releases the booking rings once with the provider amount', async () => {
    await call('cb1')
    expect(mocks.alert).toHaveBeenCalledTimes(1)
    expect(mocks.alert).toHaveBeenCalledWith(expect.anything(), ROW, { paidAmountCents: 1500 })
  })

  it('a re-check that releases nothing rings nothing', async () => {
    mocks.mark.mockResolvedValue({ released: false })
    await call('cb1')
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  it('answers with display fields only, never the buyer columns read for the push', async () => {
    const text = JSON.stringify(await (await call('cb1')).json())
    for (const v of ['Sam', 'Byrne', 'contact-uuid-1', 'loc-1']) expect(text).not.toContain(v)
  })
})
