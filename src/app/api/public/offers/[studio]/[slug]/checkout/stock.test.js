// OFFERSTOCK.1 — the stock limit at the offer checkout, on both payment rails.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  startUn1t: vi.fn(),
}))
vi.mock('@/lib/ops-alerts', () => ({ sendOpsAlert: vi.fn() }))
vi.mock('@/lib/revolut', () => ({ createOrder: (...a) => mocks.createOrder(...a) }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ allowed: true }),
  getClientIp: () => '1.2.3.4',
  rateLimitResponse: () => new Response('{}', { status: 429 }),
}))
vi.mock('@/lib/offer-checkout-un1t', () => ({ startUn1tOfferCheckout: (...a) => mocks.startUn1t(...a) }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: async () => 'c1' }))
vi.mock('@/lib/landing-pages', () => ({ studioTermsCopy: async () => null }))
vi.mock('@/lib/un1t-online-legal', () => ({ readUn1tLegalDocs: async () => ({ version: 'v3' }) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const STILL = { id: 'loc-s', slug: 'un1t-stillorgan', name: 'UN1T Stillorgan', organization_id: 'org1', membership_source: 'glofox', settings: {} }
const HATCH = { id: 'loc-h', slug: 'un1t-hatch-street', name: 'UN1T Hatch Street', organization_id: 'org1', membership_source: 'un1t_online', settings: { un1t_online: { writes_enabled: true } } }
const window = { active: true, starts_at: '2026-01-01T00:00:00Z', ends_at: '2099-01-01T00:00:00Z' }
const stillOffer = { ...window, id: 'o1', location_id: 'loc-s', slug: 'pack', category: 'class_pack', name: 'Pack', price_cents: 1000, currency: 'EUR', un1t_product_id: null, stock_limit: 4 }
const hatchOffer = { ...stillOffer, id: 'o2', location_id: 'loc-h', slug: 'month', category: 'membership', un1t_product_id: 'p1' }

const state = {}
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    rpc: async (name, args) => {
      state.rpc.push({ name, args })
      return { data: state.rpcError ? null : state.counts, error: state.rpcError }
    },
    from(table) {
      const f = {}
      const c = {
        select() { return c },
        eq(k, v) { f[k] = v; return c },
        limit() { return c },
        maybeSingle: async () => {
          if (table === 'locations') return { data: f.slug === STILL.slug ? STILL : HATCH, error: null }
          if (table === 'sale_offers') return { data: [state.still, state.hatch].find((o) => o.location_id === f.location_id && o.slug === f.slug) ?? null, error: null }
          if (table === 'un1t_products') return { data: { price_cents: 1000 }, error: null }
          if (table === 'contacts') return { data: { id: 'c1', email: 'jane@example.com' }, error: null }
          return { data: null, error: null }
        },
        insert: async () => ({ error: state.insertError }),
      }
      return c
    },
  }),
}))

import { POST } from './route'

const buy = (studio, slug, extra = {}) => POST(new Request('http://test/x', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Jane Doe', email: 'jane@example.com', phone: '0871234567', ...extra }),
}), { params: Promise.resolve({ studio, slug }) })

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(state, { still: stillOffer, hatch: hatchOffer, counts: [], rpc: [], rpcError: null, insertError: null })
  mocks.createOrder.mockResolvedValue({ id: 'ord', token: 'tok' })
  mocks.startUn1t.mockResolvedValue({ kind: 'redirect', checkoutUrl: 'https://pay.example/x' })
})

describe('offer checkout stock limit', () => {
  it('sells while stock is left, not counting the buyer against themselves', async () => {
    state.counts = [{ offer_id: 'o1', sold: 3, held: 0 }]
    const res = await buy('stillorgan', 'pack')
    expect(res.status).toBe(200)
    expect(state.rpc[0].args).toEqual({ p_offer_ids: ['o1'], p_exclude_email: 'jane@example.com' })
  })

  it('refuses a sold-out offer before any Revolut order exists', async () => {
    state.counts = [{ offer_id: 'o1', sold: 4, held: 0 }]
    const res = await buy('stillorgan', 'pack')
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('sold_out')
    expect(mocks.createOrder).not.toHaveBeenCalled()
  })

  it('says reserved, not sold out, while the last ones are only held', async () => {
    state.counts = [{ offer_id: 'o1', sold: 3, held: 1 }]
    const res = await buy('stillorgan', 'pack')
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('all_reserved')
  })

  it('refuses a sold-out un1t.online offer before touching the account', async () => {
    state.counts = [{ offer_id: 'o2', sold: 4, held: 0 }]
    const res = await buy('hatch-street', 'month', { terms_accepted: true })
    expect(res.status).toBe(409)
    expect(mocks.startUn1t).not.toHaveBeenCalled()
  })

  it('gives no token when the database refuses the last place in a race', async () => {
    state.counts = [{ offer_id: 'o1', sold: 3, held: 0 }]
    state.insertError = { code: 'OFS01' }
    const res = await buy('stillorgan', 'pack')
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.code).toBe('sold_out')
    expect(json.data).toBeUndefined()
  })

  it('passes on a un1t.online race refusal', async () => {
    mocks.startUn1t.mockResolvedValue({ kind: 'stock_refused', state: 'all_reserved' })
    const res = await buy('hatch-street', 'month', { terms_accepted: true })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('all_reserved')
  })

  it('an unreadable count never reads as sold out', async () => {
    state.rpcError = { code: '57014' }
    const res = await buy('stillorgan', 'pack')
    expect(res.status).toBe(200)
    expect(mocks.createOrder).toHaveBeenCalled()
  })

  it('an offer with no limit never asks for counts', async () => {
    state.still = { ...stillOffer, stock_limit: null }
    const res = await buy('stillorgan', 'pack')
    expect(res.status).toBe(200)
    expect(state.rpc).toEqual([])
  })
})
