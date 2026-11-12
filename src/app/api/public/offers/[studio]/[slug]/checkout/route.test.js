// POST /api/public/offers/[studio]/[slug]/checkout (BLACKFRIDAY.4; OFFERS.4
// before it). Two rails: Revolut (Stillorgan, and Hatch's non-un1t categories)
// or un1t.online's hosted checkout (Hatch memberships and packs). The handler
// lives in src/lib/offer-checkout.js; the Hatch leg (mocked here) in
// src/lib/offer-checkout-un1t.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  checkRateLimit: vi.fn(),
  startUn1t: vi.fn(),
  findContact: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  sendOpsAlert: vi.fn(),
}))
vi.mock('@/lib/ops-alerts', () => ({ sendOpsAlert: (...a) => mocks.sendOpsAlert(...a) }))
vi.mock('@/lib/revolut', () => ({ createOrder: (...a) => mocks.createOrder(...a) }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...a) => mocks.checkRateLimit(...a),
  getClientIp: () => '1.2.3.4',
  rateLimitResponse: () => new Response(JSON.stringify({ success: false, error: 'rate limited' }), { status: 429 }),
}))
vi.mock('@/lib/offer-checkout-un1t', () => ({ startUn1tOfferCheckout: (...a) => mocks.startUn1t(...a) }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: (...a) => mocks.findContact(...a) }))
vi.mock('@/lib/landing-pages', () => ({ studioTermsCopy: async () => null }))
vi.mock('@/lib/un1t-online-legal', () => ({ readUn1tLegalDocs: async () => ({ version: 'v3' }) }))
vi.mock('@/lib/log', () => ({ logError: mocks.logError, logWarn: mocks.logWarn, logInfo: vi.fn() }))

const STILL = { id: 'loc-s', slug: 'un1t-stillorgan', name: 'UN1T Stillorgan', organization_id: 'org1', membership_source: 'glofox', settings: {} }
const HATCH = { id: 'loc-h', slug: 'un1t-hatch-street', name: 'UN1T Hatch Street', organization_id: 'org1', membership_source: 'un1t_online', settings: { un1t_online: { writes_enabled: true } } }

const stillOffer = {
  id: 'offer-1', location_id: 'loc-s', slug: '20-class-pack', category: 'class_pack',
  name: '20 Class Pack', price_cents: 49700, currency: 'EUR', un1t_product_id: null,
  active: true, starts_at: '2026-08-08T00:00:00Z', ends_at: '2099-01-01T00:00:00Z',
}
const hatchMembership = {
  ...stillOffer, id: 'offer-h1', location_id: 'loc-h', slug: '3-month-membership', category: 'membership',
  name: '3 Month Membership', price_cents: 59700, un1t_product_id: 'prod-3m',
}
const hatchGift = { ...stillOffer, id: 'offer-hg', location_id: 'loc-h', slug: 'gift-card', category: 'gift_card', name: 'Gift Card', price_cents: 5000, un1t_product_id: null, ends_at: null }

const state = {}
function reset() {
  state.locations = { 'un1t-stillorgan': STILL, 'un1t-hatch-street': HATCH }
  state.offers = [stillOffer, hatchMembership, hatchGift]
  state.product = { price_cents: 59700 }
  state.productError = null
  state.contact = { id: 'c1', email: 'jane@example.com', first_name: null, last_name: null, name: 'Jane Doe', phone: '0871234567', un1t_user_id: null }
  state.insertError = null
  state.inserts = []
  state.queries = []
}

vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from(table) {
      const filters = {}
      const q = { table, filters, cols: null }
      state.queries.push(q)
      const resolve = () => {
        if (table === 'locations') return { data: state.locations[filters.slug] ?? null, error: null }
        if (table === 'sale_offers') {
          return { data: state.offers.find((o) => o.location_id === filters.location_id && o.slug === filters.slug) ?? null, error: null }
        }
        if (table === 'un1t_products') return { data: state.productError ? null : state.product, error: state.productError }
        if (table === 'contacts') return { data: filters.id === state.contact?.id ? state.contact : null, error: null }
        return { data: null, error: null }
      }
      const c = {
        select(cols) { q.cols = cols; return c },
        eq(col, v) { filters[col] = v; return c },
        limit() { return c },
        maybeSingle: async () => resolve(),
        insert: async (row) => { state.inserts.push({ table, row }); return { error: state.insertError } },
      }
      return c
    },
  }),
}))

import { POST } from './route'
import { POST as LEGACY_POST } from '../../checkout/route'

function makeRequest(body, { origin } = {}) {
  return new Request('http://test/api/public/offers/x/y/checkout', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
  })
}
const goodBody = { name: 'Jane Doe', email: 'jane@example.com', phone: '0871234567' }
const propsFor = (studio, slug) => ({ params: Promise.resolve({ studio, slug }) })
const props = propsFor('stillorgan', '20-class-pack')

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mocks.createOrder.mockResolvedValue({ id: 'ord_1', token: 'tok_1', state: 'pending' })
  mocks.checkRateLimit.mockResolvedValue({ allowed: true })
  mocks.findContact.mockResolvedValue('c1')
  mocks.startUn1t.mockResolvedValue({ kind: 'redirect', checkoutUrl: 'https://pay.un1t.online/s/abc' })
})

describe('POST /api/public/offers/[studio]/[slug]/checkout — Revolut', () => {
  it('stillorgan offer uses revolut with studio redirect', async () => {
    const res = await POST(makeRequest({ ...goodBody, amount: 1, price_cents: 1 }), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.checkout).toEqual({ provider: 'revolut', token: 'tok_1' })
    // Price comes ONLY from sale_offers; the client-sent amount is ignored.
    const sent = mocks.createOrder.mock.calls[0][0]
    expect(sent).toEqual(expect.objectContaining({ amount: 49700, currency: 'EUR' }))
    expect(sent.redirectUrl).toBe(`https://www.un1tdublin.com/offers/stillorgan/20-class-pack?purchase=${json.data.purchaseId}`)
    // REVPAY.7: buyer, our row id and the offer on the statement; default expiry (no override).
    expect(sent.customer).toEqual({ email: 'jane@example.com', fullName: 'Jane Doe' })
    expect(sent.merchantReference).toBe(`offer:${json.data.purchaseId}`)
    expect(sent.statementDescriptorSuffix).toBe('20 Class Pack')
    expect('expirePendingAfter' in sent).toBe(false)
    const { table, row } = state.inserts[0]
    expect(table).toBe('offer_purchases')
    expect(row).toEqual(expect.objectContaining({
      id: json.data.purchaseId, offer_id: 'offer-1', location_id: 'loc-s', revolut_order_id: 'ord_1',
      amount_cents: 49700, buyer_email: 'jane@example.com', payment_provider: 'revolut', origin: 'page',
    }))
    // the offer is read inside the studio's location
    const offerQ = state.queries.find((q) => q.table === 'sale_offers')
    expect(offerQ.filters).toEqual({ location_id: 'loc-s', slug: '20-class-pack' })
    expect(mocks.startUn1t).not.toHaveBeenCalled()
  })

  it('collapses whitespace in the buyer name (no newline reaches an alert subject)', async () => {
    const res = await POST(makeRequest({ ...goodBody, name: '  Jane\n\nDoe\t Smith ' }), props)
    expect(res.status).toBe(200)
    expect(state.inserts[0].row.buyer_name).toBe('Jane Doe Smith')
    expect(mocks.createOrder.mock.calls[0][0].customer.fullName).toBe('Jane Doe Smith')
  })

  it('hatch gift card uses revolut', async () => {
    const res = await POST(makeRequest(goodBody), propsFor('hatch-street', 'gift-card'))
    expect(res.status).toBe(200)
    expect(mocks.createOrder).toHaveBeenCalledTimes(1)
    expect(mocks.createOrder.mock.calls[0][0].redirectUrl).toMatch(/\/offers\/hatch-street\/gift-card\?purchase=/)
    expect(state.inserts[0].row).toEqual(expect.objectContaining({ location_id: 'loc-h', payment_provider: 'revolut' }))
    expect(mocks.startUn1t).not.toHaveBeenCalled()
  })

  describe('redirect Origin allowlist (dual-domain)', () => {
    async function redirectUrlFor(origin) {
      const res = await POST(makeRequest(goodBody, { origin }), props)
      expect(res.status).toBe(200)
      return mocks.createOrder.mock.calls.at(-1)[0].redirectUrl
    }
    it('keeps an un1tdublin.com origin', async () => {
      expect(await redirectUrlFor('https://un1tdublin.com')).toMatch(/^https:\/\/un1tdublin\.com\/offers\/stillorgan\//)
    })
    it('keeps a repset.ie apex and subdomain origin', async () => {
      expect(await redirectUrlFor('https://repset.ie')).toMatch(/^https:\/\/repset\.ie\/offers\//)
      expect(await redirectUrlFor('https://un1t-group.repset.ie')).toMatch(/^https:\/\/un1t-group\.repset\.ie\/offers\//)
    })
    it('a suffix-lookalike or foreign host falls back to the default', async () => {
      expect(await redirectUrlFor('https://evilrepset.ie')).toMatch(/^https:\/\/www\.un1tdublin\.com\/offers\//)
      expect(await redirectUrlFor('https://evilun1tdublin.com')).toMatch(/^https:\/\/www\.un1tdublin\.com\/offers\//)
      expect(await redirectUrlFor('https://attacker.example.com')).toMatch(/^https:\/\/www\.un1tdublin\.com\/offers\//)
    })
  })

  it('404 unknown slug, unknown studio, missing studio location, and another studio\'s slug', async () => {
    expect((await POST(makeRequest(goodBody), propsFor('stillorgan', 'nope'))).status).toBe(404)
    expect((await POST(makeRequest(goodBody), propsFor('dundrum', '20-class-pack'))).status).toBe(404)
    // a Hatch slug asked for under Stillorgan is not found
    expect((await POST(makeRequest(goodBody), propsFor('stillorgan', '3-month-membership'))).status).toBe(404)
    state.locations = {}
    expect((await POST(makeRequest(goodBody), props)).status).toBe(404)
    expect(mocks.createOrder).not.toHaveBeenCalled()
  })

  it('410 sale_ended outside the window', async () => {
    state.offers = [{ ...stillOffer, ends_at: '2026-08-01T00:00:00Z' }]
    const res = await POST(makeRequest(goodBody), props)
    expect(res.status).toBe(410)
    expect((await res.json()).error).toBe('sale_ended')
    expect(mocks.createOrder).not.toHaveBeenCalled()
  })

  it('upcoming offer is refused', async () => {
    state.offers = [{ ...stillOffer, starts_at: '2099-01-01T00:00:00Z', ends_at: '2099-02-01T00:00:00Z' }]
    const res = await POST(makeRequest(goodBody), props)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('not_open_yet')
    expect(mocks.createOrder).not.toHaveBeenCalled()
  })

  it('400 with issues on invalid body', async () => {
    const res = await POST(makeRequest({ name: 'J' }), props)
    expect(res.status).toBe(400)
    expect((await res.json()).issues).toBeTruthy()
  })

  it('429 when rate limited, before any order is created', async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false })
    expect((await POST(makeRequest(goodBody), props)).status).toBe(429)
    expect(mocks.checkRateLimit.mock.calls[0][1]).toBe('offerco:1.2.3.4')
    expect(mocks.createOrder).not.toHaveBeenCalled()
  })

  it('500 when the purchase row cannot be persisted (no orphan checkout token returned)', async () => {
    state.insertError = { message: 'db down' }
    const res = await POST(makeRequest(goodBody), props)
    expect(res.status).toBe(500)
    expect((await res.json()).data).toBeUndefined()
  })

  it('502 when Revolut will not create the order; nothing inserted', async () => {
    mocks.createOrder.mockRejectedValueOnce(new Error('revolut 500'))
    expect((await POST(makeRequest(goodBody), props)).status).toBe(502)
    expect(state.inserts).toHaveLength(0)
  })
})

describe('POST /api/public/offers/[studio]/[slug]/checkout — Hatch on un1t.online', () => {
  const hatch = propsFor('hatch-street', '3-month-membership')
  const ticked = { ...goodBody, terms_accepted: true }

  it('hatch membership without product is refused', async () => {
    state.offers = [{ ...hatchMembership, un1t_product_id: null }]
    const res = await POST(makeRequest(ticked), hatch)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('not_configured')
    expect(mocks.createOrder).not.toHaveBeenCalled()
    expect(mocks.startUn1t).not.toHaveBeenCalled()
    expect(state.inserts).toHaveLength(0)
  })

  it('hatch price mismatch is refused', async () => {
    state.product = { price_cents: 62700 }
    const res = await POST(makeRequest(ticked), hatch)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('price_mismatch')
    expect(mocks.logError).toHaveBeenCalledTimes(1)
    expect(mocks.logError.mock.calls[0][0]).toBe('offers')
    // BLACKFRIDAY.9 — staff get one alert naming both prices and the studio.
    expect(mocks.sendOpsAlert).toHaveBeenCalledTimes(1)
    const [alert] = mocks.sendOpsAlert.mock.calls[0]
    expect(alert.subject).toBe('BLACK FRIDAY: price mismatch on 3 Month Membership')
    expect(alert.locationId).toBe('loc-h')
    expect(alert.htmlBody).toContain('€597.00')
    expect(alert.htmlBody).toContain('€627.00')
    expect(alert.htmlBody).toContain('UN1T Hatch Street')
    const productQ = state.queries.find((q) => q.table === 'un1t_products')
    expect(productQ.filters).toEqual({ location_id: 'loc-h', un1t_id: 'prod-3m' })
    expect(mocks.createOrder).not.toHaveBeenCalled()
    expect(mocks.startUn1t).not.toHaveBeenCalled()
  })

  it('the price mismatch alert escapes the offer name and never blocks the 409', async () => {
    state.offers = [{ ...hatchMembership, name: '3 Month <a href=x>Membership' }]
    state.product = { price_cents: 62700 }
    mocks.sendOpsAlert.mockRejectedValueOnce(new Error('postmark down'))
    const res = await POST(makeRequest(ticked), hatch)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('price_mismatch')
    const [alert] = mocks.sendOpsAlert.mock.calls[0]
    expect(alert.htmlBody).not.toContain('<a href=x>')
    expect(alert.htmlBody).toContain('&lt;a href=x&gt;')
  })

  it('a product-carrying offer outside the un1t.online combination is not_configured, never Revolut', async () => {
    state.offers = [{ ...hatchGift, un1t_product_id: 'prod-gift' }, { ...stillOffer, un1t_product_id: 'prod-still' }]
    for (const p of [propsFor('hatch-street', 'gift-card'), propsFor('stillorgan', '20-class-pack')]) {
      const res = await POST(makeRequest(ticked), p)
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('not_configured')
    }
    expect(mocks.createOrder).not.toHaveBeenCalled()
    expect(mocks.startUn1t).not.toHaveBeenCalled()
    expect(state.inserts).toHaveLength(0)
  })

  it('a product missing from the mirror is not_configured; an unreadable mirror is busy', async () => {
    state.product = null
    expect((await POST(makeRequest(ticked), hatch)).status).toBe(409)
    state.productError = { code: '57014' }
    const res = await POST(makeRequest(ticked), hatch)
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('busy')
    expect(mocks.createOrder).not.toHaveBeenCalled()
  })

  it('writes off is not_configured, never Revolut', async () => {
    state.locations['un1t-hatch-street'] = { ...HATCH, settings: { un1t_online: { writes_enabled: false } } }
    const res = await POST(makeRequest(ticked), hatch)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('not_configured')
    expect(mocks.createOrder).not.toHaveBeenCalled()
  })

  it('hatch requires terms', async () => {
    const res = await POST(makeRequest(goodBody), hatch)
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.code).toBe('terms_required')
    expect(json.terms.required).toBe(true)
    expect(json.terms.terms_url).toContain('/legal/un1t/hatch-street/')
    expect(mocks.findContact).not.toHaveBeenCalled()
    expect(mocks.startUn1t).not.toHaveBeenCalled()
  })

  it('hatch happy path redirects', async () => {
    const res = await POST(makeRequest(ticked), hatch)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.checkout).toEqual({ provider: 'un1t_online', url: 'https://pay.un1t.online/s/abc' })
    expect(mocks.findContact).toHaveBeenCalledWith(expect.objectContaining({
      locationId: 'loc-h', email: 'jane@example.com', restrictToOrg: true, insertFields: { lead_source: 'offer_sale' },
    }))
    const contactQ = state.queries.find((q) => q.table === 'contacts')
    expect(contactQ.cols).toBe('id, email, first_name, last_name, name, phone, un1t_user_id')
    const [, args] = mocks.startUn1t.mock.calls[0]
    expect(args.purchaseId).toBe(json.data.purchaseId)
    expect(args.offer.id).toBe('offer-h1')
    expect(args.location.id).toBe('loc-h')
    expect(args.contact.id).toBe('c1')
    expect(args.buyer).toEqual({ name: 'Jane Doe', email: 'jane@example.com', phone: '0871234567' })
    expect(args.terms).toEqual(expect.objectContaining({ terms_source: 'website', terms_version: 'v3' }))
    expect(typeof args.terms.terms_accepted_at).toBe('string')
    expect(mocks.createOrder).not.toHaveBeenCalled()
  })

  it('help_filed is 202 with the help copy; unavailable is 503 busy', async () => {
    mocks.startUn1t.mockResolvedValueOnce({ kind: 'help_filed' })
    let res = await POST(makeRequest(ticked), hatch)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ success: false, code: 'help_filed', error: "We couldn't open the checkout. The team has your details and will be in touch today." })

    mocks.startUn1t.mockResolvedValueOnce({ kind: 'unavailable', code: 'rate_limited' })
    res = await POST(makeRequest(ticked), hatch)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ success: false, code: 'busy', error: 'Busy right now, please try again in a minute.' })
    expect(mocks.createOrder).not.toHaveBeenCalled()
  })

  it('a contact that cannot be captured stops before the checkout', async () => {
    mocks.findContact.mockResolvedValueOnce(null)
    expect((await POST(makeRequest(ticked), hatch)).status).toBe(500)
    expect(mocks.startUn1t).not.toHaveBeenCalled()
  })
})

describe('POST /api/public/offers/[slug]/checkout (legacy, pre-deploy pages)', () => {
  it('old slug route delegates to stillorgan', async () => {
    // Next.js names the legacy segment [studio]; its value is a Stillorgan offer slug.
    const res = await LEGACY_POST(makeRequest(goodBody), { params: Promise.resolve({ studio: '20-class-pack' }) })
    expect(res.status).toBe(200)
    const offerQ = state.queries.find((q) => q.table === 'sale_offers')
    expect(offerQ.filters).toEqual({ location_id: 'loc-s', slug: '20-class-pack' })
    expect(mocks.createOrder.mock.calls[0][0].redirectUrl).toMatch(/\/offers\/stillorgan\/20-class-pack\?purchase=/)
  })
})
