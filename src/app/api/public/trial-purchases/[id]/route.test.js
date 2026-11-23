// TRIALSTUDIO.7 — GET /api/public/trial-purchases/[id]: a Hatch Street
// (un1t.online) row is settled by the cron off the un1t.online mirror, so the
// poll never re-checks a provider for it and hands back no checkout; a
// Stillorgan (Revolut) row still re-checks while pending.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ alert: vi.fn(async () => ({ sent: true })), rateLimit: vi.fn(), getPayment: vi.fn(), paymentsFor: vi.fn(), mark: vi.fn(), push: vi.fn(), row: null, selects: [], gate: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.rateLimit }))
vi.mock('@/lib/payments', () => ({ paymentsFor: mocks.paymentsFor }))
vi.mock('@/lib/trial-purchase-payments', () => ({ markTrialPurchasePaymentStatus: mocks.mark }))
vi.mock('@/lib/qstash', () => ({ publishQueuePush: mocks.push, TRIAL_PURCHASES_WORKER_PATH: '/api/workers/trial-purchases' }))
// HATCHTRACK.1 — the paid gate has its own tests (trial-purchase-un1t-resume.test.js); here it answers what a test sets.
vi.mock('@/lib/trial-purchase-un1t-resume', () => ({ un1tRetryGate: mocks.gate }))
vi.mock('@/lib/sale-alert-sources', () => ({ alertTrialSale: mocks.alert }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const b = { select: (cols) => { mocks.selects.push(String(cols)); return b }, eq: () => b, maybeSingle: async () => ({ data: mocks.row, error: null }) }
      return b
    },
  }),
}))

import { GET } from './route'

const call = (id) => GET(new Request(`http://x/api/public/trial-purchases/${id}`), { params: Promise.resolve({ id }) })

const BASE = { id: 'tp1', amount_cents: 3900, currency: 'EUR', product_name: 'The UN1T Trial', duration_days: 14, connected_account_id: null }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.selects.length = 0
  mocks.rateLimit.mockResolvedValue({ allowed: true })
  mocks.getPayment.mockResolvedValue({ state: 'pending', amountCents: 3900 })
  mocks.paymentsFor.mockReturnValue({ getPayment: mocks.getPayment })
  mocks.mark.mockResolvedValue({ released: false })
  mocks.gate.mockResolvedValue({ ok: true, ledger: [] })
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

  // SALEALERT.1 — the poll that wins the paid transition rings the sale push; one that does not, never does.
  it('a poll that releases the row rings the sale push once, naming the buyer from a server-side read', async () => {
    mocks.row = { ...BASE, status: 'awaiting_payment', payment_status: 'pending', payment_provider: 'revolut', payment_provider_ref: 'ord1', payment_checkout_token: 'tok', payment_checkout_url: null, location_id: 'loc-1' }
    mocks.mark.mockResolvedValue({ released: true })
    mocks.getPayment.mockResolvedValue({ state: 'completed', amountCents: 3900 })
    await call('tp1')
    expect(mocks.alert).toHaveBeenCalledTimes(1)
    expect(mocks.alert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'tp1', location_id: 'loc-1' }), { paidAmountCents: 3900 })
  })

  it('a poll that releases nothing rings no sale push', async () => {
    mocks.row = { ...BASE, status: 'awaiting_payment', payment_status: 'pending', payment_provider: 'revolut', payment_provider_ref: 'ord1', payment_checkout_token: 'tok', payment_checkout_url: null }
    mocks.mark.mockResolvedValue({ released: false })
    await call('tp1')
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  // TRIALLEAK.1 — `resumable`: may the page put the checkout back?
  const OPEN_REVOLUT = { ...BASE, status: 'awaiting_payment', payment_status: 'pending', payment_provider: 'revolut', payment_provider_ref: 'ord1', payment_checkout_token: 'tok', payment_checkout_url: null }
  const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString()
  it('a young, unpaid Revolut row is resumable; past the reuse window it is not', async () => {
    mocks.row = { ...OPEN_REVOLUT, created_at: minutesAgo(20) }
    expect((await (await call('tp1')).json()).data).toMatchObject({ state: 'pending', resumable: true, checkout: { token: 'tok' } })
    mocks.row = { ...OPEN_REVOLUT, created_at: minutesAgo(115) }
    expect((await (await call('tp1')).json()).data).toMatchObject({ state: 'pending', resumable: false })
  })
  it('a Hatch row, a paid row and a failed row are never resumable', async () => {
    mocks.row = { ...OPEN_REVOLUT, payment_provider: 'un1t_online', payment_checkout_token: null, created_at: minutesAgo(5) }
    expect((await (await call('tp1')).json()).data.resumable).toBe(false)
    mocks.row = { ...OPEN_REVOLUT, status: 'queued', payment_status: 'paid', created_at: minutesAgo(5) }
    expect((await (await call('tp1')).json()).data).toMatchObject({ state: 'paid', resumable: false })
    mocks.row = { ...OPEN_REVOLUT, status: 'payment_failed', payment_status: 'expired', created_at: minutesAgo(5) }
    expect((await (await call('tp1')).json()).data).toMatchObject({ state: 'failed', payment_status: 'expired', resumable: false })
  })

  // HATCHTRACK.1 — `retryable`: may the page send a Hatch buyer back to payment?
  const OPEN_HATCH = { ...BASE, status: 'awaiting_payment', payment_status: 'pending', payment_provider: 'un1t_online', payment_provider_ref: null, payment_checkout_token: null, payment_checkout_url: null, un1t_user_id: 'u-77', un1t_product_id: 'prod-1' }
  const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString()
  it('a Hatch row is retryable exactly when the paid gate passes (asked without the live read); a Revolut row never asks it', async () => {
    mocks.row = { ...OPEN_HATCH, created_at: hoursAgo(3) }
    expect((await (await call('tp1')).json()).data).toMatchObject({ state: 'pending', retryable: true, resumable: false, checkout: null })
    expect(mocks.gate).toHaveBeenCalledTimes(1)
    // The row and nothing else: no `live`, so a poll never calls un1t.online.
    expect(mocks.gate.mock.calls[0].slice(1)).toEqual([mocks.row])
    mocks.gate.mockClear()
    mocks.row = { ...OPEN_HATCH, payment_provider: 'revolut', payment_provider_ref: 'ord1', payment_checkout_token: 'tok', created_at: hoursAgo(1) }
    expect((await (await call('tp1')).json()).data.retryable).toBe(false)
    expect(mocks.gate).not.toHaveBeenCalled()
  })
  it('a payment in the mirror, a checkout from before the paid=1 return, a row that is no longer open, or a read that failed: not retryable, so the page keeps its being-confirmed screen', async () => {
    for (const reason of ['paid_in_mirror', 'legacy_checkout', 'not_retryable', 'read_failed']) {
      mocks.gate.mockResolvedValueOnce({ ok: false, reason })
      mocks.row = { ...OPEN_HATCH, created_at: hoursAgo(1) }
      expect((await (await call('tp1')).json()).data).toMatchObject({ state: 'pending', retryable: false })
    }
  })

  // HATCHTRACK.1 — the row now holds the buyer's IP address and user agent
  // (attribution.client_ip / client_user_agent) as well as their name, email
  // and phone. None of it may ever leave through this anonymous route: not as
  // a column it reads, and not in what it answers, whatever the row holds.
  it('reads no column that names the buyer and never answers with one, even if the row carried them', async () => {
    const secrets = {
      customer_name: 'Sam Byrne', first_name: 'Sam', last_name: 'Byrne', customer_email: 'sam@example.com', customer_phone: '0871234567',
      contact_id: 'contact-uuid-1', un1t_ledger_id: 'ledger-uuid-1',
      attribution: { client_ip: '203.0.113.9', client_user_agent: 'Mozilla/5.0 SecretAgent', fbc: 'fb.1.1.CLICK', fbp: 'fb.1.2.3', utm_campaign: 'reset' },
    }
    for (const base of [OPEN_HATCH, OPEN_REVOLUT]) {
      mocks.selects.length = 0
      mocks.row = { ...base, created_at: hoursAgo(1), ...secrets }
      const r = await call('tp1')
      const text = JSON.stringify(await r.json())
      for (const v of ['Sam', 'Byrne', 'sam@example.com', '0871234567', '203.0.113.9', 'SecretAgent', 'fb.1.1.CLICK', 'fb.1.2.3', 'contact-uuid-1', 'ledger-uuid-1', 'u-77', 'prod-1']) {
        expect(text).not.toContain(v)
      }
      for (const k of ['attribution', 'client_ip', 'client_user_agent', 'customer_', 'first_name', 'last_name', 'contact_id', 'un1t_user_id', 'un1t_product_id', 'fbc', 'fbp']) {
        expect(text).not.toContain(k)
      }
      // Every read names its columns (never `*`), and none is the buyer's.
      expect(mocks.selects.length).toBeGreaterThan(0)
      for (const cols of mocks.selects) {
        const list = cols.split(',').map((c) => c.trim())
        expect(list).not.toContain('*')
        for (const c of ['attribution', 'customer_name', 'customer_email', 'customer_phone', 'first_name', 'last_name', 'contact_id']) expect(list).not.toContain(c)
      }
    }
  })
})
