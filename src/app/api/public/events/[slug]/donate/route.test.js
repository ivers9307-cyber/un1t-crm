// CHARITY.5 — POST /api/public/events/[slug]/donate: the amount is validated
// before any DB read and against the EVENT's bounds after it, registration
// state is irrelevant, the row is inserted `awaiting_payment` with no
// contact_id (the paid side effects link it), and a failed provider order
// marks the row failed and answers 502.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(), event: vi.fn(), inserted: vi.fn(), updated: vi.fn(), payment: vi.fn(), base: vi.fn(),
  eqs: [],
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.rateLimit, getClientIp: () => '1.2.3.4', rateLimitResponse: () => new Response('rate', { status: 429 }) }))
vi.mock('@/lib/donation-payments', () => ({ createDonationPayment: mocks.payment, DONATION_COLS: 'id, amount_cents' }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: mocks.base }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      if (table === 'race_events') {
        const c = { select: () => c, eq: (k, v) => { mocks.eqs.push([k, v]); return c }, single: mocks.event }
        return c
      }
      if (table === 'donations') {
        return {
          insert: (row) => ({ select: () => ({ single: async () => mocks.inserted(row) }) }),
          update: (patch) => ({ eq: async (k, v) => mocks.updated(patch, k, v) }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

import { POST } from './route'

const RACE = {
  id: 'ev1', slug: 'hyrox', name: 'Hyrox', kind: 'race', location_id: 'loc1', active: true, status: 'published',
  payment_currency: 'EUR', charity_enabled: true, charity: null, host_id: null, host: null,
}
const BODY = { amount_cents: 2500, name: 'Ava Byrne', email: ' Ava@Example.com ', message: 'Go team', marketing_opt_in: true, attribution: { utm_campaign: 'c1' } }
const req = (body) => new Request('http://x/api/public/events/hyrox/donate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const call = (body) => POST(req(body), { params: Promise.resolve({ slug: 'hyrox' }) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.eqs.length = 0
  mocks.rateLimit.mockResolvedValue({ allowed: true })
  mocks.event.mockResolvedValue({ data: RACE, error: null })
  mocks.inserted.mockImplementation(async (row) => ({ data: { id: 'd1', ...row }, error: null }))
  mocks.updated.mockResolvedValue({ error: null })
  mocks.base.mockResolvedValue('https://un1t.example')
  mocks.payment.mockResolvedValue({ donationId: 'd1', checkout: { provider: 'revolut', token: 'tok', url: null, connectedAccountId: null } })
})

describe('POST /api/public/events/[slug]/donate', () => {
  it.each([
    ['a float', 25.5],
    ['zero', 0],
    ['negative', -500],
    ['a string', '2500'],
  ])('400s %s amount before any database read', async (_n, amount_cents) => {
    const r = await call({ ...BODY, amount_cents })
    expect(r.status).toBe(400)
    expect(mocks.event).not.toHaveBeenCalled()
    expect(mocks.inserted).not.toHaveBeenCalled()
  })

  it('400s a malformed name or email before any database read', async () => {
    expect((await call({ ...BODY, email: 'nope' })).status).toBe(400)
    expect((await call({ ...BODY, name: '   ' })).status).toBe(400)
    expect(mocks.event).not.toHaveBeenCalled()
  })

  it('429s over the rate limit, keyed on slug and ip', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false })
    const r = await call(BODY)
    expect(r.status).toBe(429)
    expect(mocks.rateLimit).toHaveBeenCalledWith(expect.anything(), 'donate:hyrox:1.2.3.4', { max: 10, windowMs: 15 * 60_000 })
    expect(mocks.inserted).not.toHaveBeenCalled()
  })

  it('404s an unknown, inactive or unpublished event', async () => {
    mocks.event.mockResolvedValue({ data: null, error: { message: 'none' } })
    expect((await call(BODY)).status).toBe(404)
    mocks.event.mockResolvedValue({ data: { ...RACE, status: 'draft' }, error: null })
    expect((await call(BODY)).status).toBe(404)
    expect(mocks.eqs).toEqual(expect.arrayContaining([['slug', 'hyrox'], ['active', true], ['status', 'published']]))
    expect(mocks.inserted).not.toHaveBeenCalled()
  })

  it('400s not_enabled when the charity section is off', async () => {
    mocks.event.mockResolvedValue({ data: { ...RACE, charity_enabled: false }, error: null })
    const r = await call(BODY)
    expect(r.status).toBe(400)
    expect((await r.json()).code).toBe('not_enabled')
    expect(mocks.inserted).not.toHaveBeenCalled()
  })

  it('400s invalid_amount below the default minimum and above the maximum', async () => {
    const low = await call({ ...BODY, amount_cents: 400 })
    expect(low.status).toBe(400)
    expect((await low.json()).code).toBe('invalid_amount')
    const high = await call({ ...BODY, amount_cents: 500001 })
    expect((await high.json()).code).toBe('invalid_amount')
    expect(mocks.inserted).not.toHaveBeenCalled()
  })

  it('uses the operator bounds, and only presets when custom amounts are off', async () => {
    mocks.event.mockResolvedValue({ data: { ...RACE, charity: { min_cents: 100, max_cents: 1000 } }, error: null })
    expect((await call({ ...BODY, amount_cents: 1500 })).status).toBe(400)
    expect((await call({ ...BODY, amount_cents: 100 })).status).toBe(200)
    mocks.event.mockResolvedValue({ data: { ...RACE, charity: { custom_allowed: false, presets_cents: [1000, 2500] } }, error: null })
    const off = await call({ ...BODY, amount_cents: 1700 })
    expect(off.status).toBe(400)
    expect((await off.json()).code).toBe('invalid_amount')
    expect((await call({ ...BODY, amount_cents: 2500 })).status).toBe(200)
  })

  it('accepts a donation for an event whose registration is closed or full', async () => {
    mocks.event.mockResolvedValue({ data: { ...RACE, registration_closes_at: '2020-01-01T00:00:00Z', capacity_mode: 'full' }, error: null })
    expect((await call(BODY)).status).toBe(200)
  })

  it('inserts the awaiting_payment row without a contact and returns the checkout', async () => {
    const r = await call(BODY)
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j).toEqual({ success: true, data: { donation: { id: 'd1', amount_cents: 2500, currency: 'EUR', checkout: { provider: 'revolut', token: 'tok', url: null, connectedAccountId: null } } } })
    const row = mocks.inserted.mock.calls[0][0]
    expect(row).toEqual({
      race_event_id: 'ev1', location_id: 'loc1', donor_name: 'Ava Byrne', donor_email: 'Ava@Example.com',
      message: 'Go team', amount_cents: 2500, currency: 'EUR', status: 'awaiting_payment',
      marketing_opt_in: true, attribution: { utm_campaign: 'c1' },
    })
    expect('contact_id' in row).toBe(false)
    expect(mocks.base).toHaveBeenCalledWith(expect.anything(), 'loc1')
    expect(mocks.payment).toHaveBeenCalledWith(expect.objectContaining({
      race: RACE, host: null, returnUrl: 'https://un1t.example/event/hyrox?donation=d1',
      donation: expect.objectContaining({ id: 'd1' }),
    }))
  })

  it('defaults an absent message, opt-in and attribution, and the currency', async () => {
    mocks.event.mockResolvedValue({ data: { ...RACE, payment_currency: null }, error: null })
    await call({ amount_cents: 2500, name: 'Ava', email: 'a@b.ie' })
    expect(mocks.inserted.mock.calls[0][0]).toMatchObject({ message: null, marketing_opt_in: false, attribution: null, currency: 'EUR' })
  })

  it('500s unavailable when the insert fails', async () => {
    mocks.inserted.mockResolvedValue({ data: null, error: { message: 'db' } })
    const r = await call(BODY)
    expect(r.status).toBe(500)
    expect((await r.json()).code).toBe('unavailable')
    expect(mocks.payment).not.toHaveBeenCalled()
  })

  it('400s payments_unavailable without failing the row when the host cannot take payments', async () => {
    mocks.payment.mockRejectedValue(Object.assign(new Error('payments_unavailable'), { code: 'payments_unavailable' }))
    const r = await call(BODY)
    expect(r.status).toBe(400)
    expect((await r.json()).code).toBe('payments_unavailable')
  })

  it('502s checkout_failed and marks the row failed when the provider order fails', async () => {
    mocks.payment.mockRejectedValue(new Error('boom'))
    const r = await call(BODY)
    expect(r.status).toBe(502)
    expect((await r.json()).code).toBe('checkout_failed')
    expect(mocks.updated).toHaveBeenCalledWith({ status: 'failed' }, 'id', 'd1')
  })

  it('still answers 502 when marking the row failed also fails', async () => {
    mocks.payment.mockRejectedValue(new Error('boom'))
    mocks.updated.mockResolvedValue({ error: { message: 'db' } })
    expect((await call(BODY)).status).toBe(502)
  })
})
