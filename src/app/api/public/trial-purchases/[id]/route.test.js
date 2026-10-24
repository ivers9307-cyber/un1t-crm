// TRIALSTUDIO.7 — GET /api/public/trial-purchases/[id]: a Hatch Street
// (un1t.online) row is settled by the cron off the un1t.online mirror, so the
// poll never re-checks a provider for it and hands back no checkout; a
// Stillorgan (Revolut) row still re-checks while pending.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ rateLimit: vi.fn(), getPayment: vi.fn(), paymentsFor: vi.fn(), mark: vi.fn(), push: vi.fn(), row: null }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.rateLimit }))
vi.mock('@/lib/payments', () => ({ paymentsFor: mocks.paymentsFor }))
vi.mock('@/lib/trial-purchase-payments', () => ({ markTrialPurchasePaymentStatus: mocks.mark }))
vi.mock('@/lib/qstash', () => ({ publishQueuePush: mocks.push, TRIAL_PURCHASES_WORKER_PATH: '/api/workers/trial-purchases' }))
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

const call = (id) => GET(new Request(`http://x/api/public/trial-purchases/${id}`), { params: Promise.resolve({ id }) })

const BASE = { id: 'tp1', amount_cents: 3900, currency: 'EUR', product_name: 'The UN1T Trial', duration_days: 14, connected_account_id: null }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rateLimit.mockResolvedValue({ allowed: true })
  mocks.getPayment.mockResolvedValue({ state: 'pending', amountCents: 3900 })
  mocks.paymentsFor.mockReturnValue({ getPayment: mocks.getPayment })
  mocks.mark.mockResolvedValue({ released: false })
})

describe('GET /api/public/trial-purchases/[id]', () => {
  it('status route: a un1t row answers pending with checkout null and never calls the provider', async () => {
    // payment_status 'pending' and a ref on purpose: the provider still must not be asked.
    mocks.row = { ...BASE, status: 'awaiting_payment', payment_status: 'pending', payment_provider: 'un1t_online', payment_provider_ref: 'tx-x', payment_checkout_token: null, payment_checkout_url: null }
    const r = await call('tp1')
    expect(r.status).toBe(200)
    const { data } = await r.json()
    expect(data).toMatchObject({ id: 'tp1', state: 'pending', paid: false, purchase_status: 'awaiting_payment', checkout: null })
    expect(mocks.rateLimit).not.toHaveBeenCalled()
    expect(mocks.paymentsFor).not.toHaveBeenCalled()
    expect(mocks.getPayment).not.toHaveBeenCalled()
    expect(mocks.mark).not.toHaveBeenCalled()
  })

  it('an expired un1t row answers expired', async () => {
    mocks.row = { ...BASE, status: 'expired', payment_status: null, payment_provider: 'un1t_online', payment_provider_ref: null, payment_checkout_token: null, payment_checkout_url: null }
    const { data } = await (await call('tp1')).json()
    expect(data).toMatchObject({ state: 'expired', checkout: null })
    expect(mocks.paymentsFor).not.toHaveBeenCalled()
  })

  it('a pending Revolut row still re-checks the provider and keeps its checkout', async () => {
    mocks.row = { ...BASE, status: 'awaiting_payment', payment_status: 'pending', payment_provider: 'revolut', payment_provider_ref: 'ord1', payment_checkout_token: 'tok', payment_checkout_url: null }
    const { data } = await (await call('tp1')).json()
    expect(mocks.paymentsFor).toHaveBeenCalledWith('revolut')
    expect(mocks.getPayment).toHaveBeenCalledWith('ord1', { connectedAccountId: null })
    expect(data.checkout).toEqual({ provider: 'revolut', token: 'tok', url: null })
  })
})
