import { describe, it, expect, vi, beforeEach } from 'vitest'

const createOrder = vi.fn(async () => ({ id: 'ord_1', token: 'tok_1', state: 'pending' }))
vi.mock('@/lib/revolut', () => ({ createOrder: (...a) => createOrder(...a) }))
const checkRateLimit = vi.fn(async () => ({ allowed: true }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...a) => checkRateLimit(...a),
  getClientIp: () => '1.2.3.4',
  rateLimitResponse: () => new Response(JSON.stringify({ success: false, error: 'rate limited' }), { status: 429 }),
}))

const openOffer = {
  id: 'offer-1', location_id: 'loc1', slug: '3-month-membership',
  name: '3 Month Membership', price_cents: 49700, currency: 'EUR',
  active: true, starts_at: '2026-08-08T00:00:00Z', ends_at: '2099-01-01T00:00:00Z',
}

const state = { offer: openOffer, insertError: null, inserts: [] }
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    _table: null,
    from(t) { this._table = t; return this },
    select() { return this },
    eq() { return this },
    maybeSingle: async () => ({ data: state.offer }),
    insert: (row) => { state.inserts.push(row); return Promise.resolve({ error: state.insertError }) },
  }),
}))

import { POST } from './route'

function makeRequest(body, { origin } = {}) {
  return new Request('http://test/api/public/offers/3-month-membership/checkout', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
  })
}
const goodBody = { name: 'Jane Doe', email: 'jane@example.com', phone: '0871234567' }
const props = { params: Promise.resolve({ slug: '3-month-membership' }) }

beforeEach(() => {
  createOrder.mockClear()
  checkRateLimit.mockClear()
  state.offer = openOffer
  state.insertError = null
  state.inserts = []
})

describe('POST /api/public/offers/[slug]/checkout', () => {
  it('creates the Revolut order at the DB price and inserts the purchase row', async () => {
    const res = await POST(makeRequest({ ...goodBody, amount: 1, price_cents: 1 }), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.checkout).toEqual({ provider: 'revolut', token: 'tok_1' })
    expect(json.data.purchaseId).toBeTruthy()
    // Price comes ONLY from sale_offers — the client-sent amount is ignored.
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 49700, currency: 'EUR' }))
    // Redirect target for app-handoff methods (Revolut Pay mobile): the
    // product page + purchase id, on the allowlisted marketing origin.
    const { redirectUrl } = createOrder.mock.calls[0][0]
    expect(redirectUrl).toMatch(/^https:\/\/www\.un1tdublin\.com\/offers\/3-month-membership\?purchase=.+/)
    expect(redirectUrl).toContain(`purchase=${json.data.purchaseId}`)
    const inserted = state.inserts[0]
    expect(inserted).toEqual(expect.objectContaining({
      offer_id: 'offer-1', location_id: 'loc1', revolut_order_id: 'ord_1',
      amount_cents: 49700, buyer_email: 'jane@example.com',
    }))
  })
  // REPSET-P6 — the Origin allowlist for the Revolut redirect target
  // accepts repset.ie + subdomains alongside un1tdublin.com. A forged
  // Origin must still never point Revolut's redirect off-brand, and
  // the no-Origin default stays the marketing host (unchanged).
  describe('redirect Origin allowlist (dual-domain)', () => {
    async function redirectUrlFor(origin) {
      const res = await POST(makeRequest(goodBody, { origin }), props)
      expect(res.status).toBe(200)
      return createOrder.mock.calls[0][0].redirectUrl
    }

    it('keeps an un1tdublin.com origin (existing behaviour)', async () => {
      expect(await redirectUrlFor('https://un1tdublin.com')).toMatch(/^https:\/\/un1tdublin\.com\/offers\//)
    })

    it('keeps a repset.ie apex origin', async () => {
      expect(await redirectUrlFor('https://repset.ie')).toMatch(/^https:\/\/repset\.ie\/offers\//)
    })

    it('keeps a repset.ie subdomain origin (www., crm.)', async () => {
      expect(await redirectUrlFor('https://www.repset.ie')).toMatch(/^https:\/\/www\.repset\.ie\/offers\//)
      createOrder.mockClear()
      expect(await redirectUrlFor('https://crm.repset.ie')).toMatch(/^https:\/\/crm\.repset\.ie\/offers\//)
    })

    it('a suffix-lookalike host falls back to the default (evilrepset.ie, evilun1tdublin.com)', async () => {
      expect(await redirectUrlFor('https://evilrepset.ie')).toMatch(/^https:\/\/www\.un1tdublin\.com\/offers\//)
      createOrder.mockClear()
      expect(await redirectUrlFor('https://evilun1tdublin.com')).toMatch(/^https:\/\/www\.un1tdublin\.com\/offers\//)
    })

    it('a foreign origin falls back to the default', async () => {
      expect(await redirectUrlFor('https://attacker.example.com')).toMatch(/^https:\/\/www\.un1tdublin\.com\/offers\//)
    })
  })

  it('404 unknown slug', async () => {
    state.offer = null
    expect((await POST(makeRequest(goodBody), props)).status).toBe(404)
    expect(createOrder).not.toHaveBeenCalled()
  })
  it('410 sale_ended outside the window', async () => {
    state.offer = { ...openOffer, ends_at: '2026-08-01T00:00:00Z' }
    const res = await POST(makeRequest(goodBody), props)
    expect(res.status).toBe(410)
    expect((await res.json()).error).toBe('sale_ended')
    expect(createOrder).not.toHaveBeenCalled()
  })
  it('400 with issues on invalid body', async () => {
    const res = await POST(makeRequest({ name: 'J' }), props)
    expect(res.status).toBe(400)
    expect((await res.json()).issues).toBeTruthy()
  })
  it('429 when rate limited, before any order is created', async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false })
    expect((await POST(makeRequest(goodBody), props)).status).toBe(429)
    expect(createOrder).not.toHaveBeenCalled()
  })
  it('500 when the purchase row cannot be persisted (no orphan checkout token returned)', async () => {
    state.insertError = { message: 'db down' }
    expect((await POST(makeRequest(goodBody), props)).status).toBe(500)
  })
})
