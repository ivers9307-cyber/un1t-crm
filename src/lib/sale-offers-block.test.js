// SALEPAGE.1 — the server side of a page-builder sale.
import { describe, it, expect, vi } from 'vitest'
import { createFakeDb } from '../../tests/helpers/fake-db.js'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
const { sellableSaleOffers, chosenSaleOffers, saleOfferView } = await import('./sale-offers-block.js')
const { offerConfigured } = await import('./landing-page-offers.js')

const HATCH = '00000000-0000-4000-8000-0000000000a1'
const STILL = '00000000-0000-4000-8000-0000000000a2'
const OTHER = '00000000-0000-4000-8000-0000000000a3'
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const NOW = new Date('2026-11-20T12:00:00Z')
const offer = (n, over = {}) => ({
  id: id(n), location_id: STILL, slug: `o${n}`, category: 'class_pack', name: `Offer ${n}`, bonus_headline: '5 free',
  description: '', fine_print: '', price_cents: 1000, currency: 'EUR', active: true,
  starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-12-01T00:00:00Z', sort: n, stock_limit: null, un1t_product_id: null, ...over,
})
const db = (offers, products = []) => createFakeDb({
  tables: {
    locations: [
      { id: HATCH, slug: 'un1t-hatch-street', name: 'Hatch', membership_source: 'un1t_online' },
      { id: STILL, slug: 'un1t-stillorgan', name: 'Stillorgan', membership_source: 'glofox' },
      { id: OTHER, slug: 'elsewhere', name: 'Elsewhere', membership_source: 'glofox' },
    ],
    sale_offers: offers,
    un1t_products: products,
  },
})

describe('sellableSaleOffers', () => {
  it('lists only active offers the storefront could sell today, with the studio\'s /offers key', async () => {
    const r = await sellableSaleOffers(db([
      offer(1), offer(2, { active: false }), offer(3, { ends_at: '2026-11-10T00:00:00Z' }),
      offer(4, { starts_at: '2026-12-05T00:00:00Z', ends_at: null }),
    ]), STILL, { now: NOW })
    expect(r.ok).toBe(true)
    expect(r.studioKey).toBe('stillorgan')
    expect(r.offers.map((o) => o.id)).toEqual([id(1), id(4)])
    expect('un1t_product_id' in r.offers[0]).toBe(false)
  })

  it('at a un1t.online studio an offer needs its product at the same price', async () => {
    const offers = [
      offer(1, { location_id: HATCH, un1t_product_id: 'p1' }),
      offer(2, { location_id: HATCH, un1t_product_id: 'p2' }),
      offer(3, { location_id: HATCH }),
      offer(4, { location_id: HATCH, category: 'gift_card' }),
    ]
    const products = [
      { id: id(91), location_id: HATCH, un1t_id: 'p1', price_cents: 1000 },
      { id: id(92), location_id: HATCH, un1t_id: 'p2', price_cents: 900 },
    ]
    const r = await sellableSaleOffers(db(offers, products), HATCH, { now: NOW })
    expect(r.studioKey).toBe('hatch-street')
    expect(r.offers.map((o) => o.id)).toEqual([id(1), id(4)])
  })

  it('a studio with no /offers page has no key; another studio\'s offers never show', async () => {
    const r = await sellableSaleOffers(db([offer(1)]), OTHER, { now: NOW })
    expect(r).toEqual({ ok: true, studioKey: null, offers: [] })
  })

  it('a failed read is not "no offers"', async () => {
    const d = createFakeDb({ tables: { locations: [{ id: STILL, slug: 'un1t-stillorgan', membership_source: 'glofox' }] }, errors: { sale_offers: { select: { message: 'down' } } } })
    expect(await sellableSaleOffers(d, STILL, { now: NOW })).toEqual({ ok: false })
  })
})

describe('chosenSaleOffers and saleOfferView', () => {
  it('keeps the studio\'s chosen order and drops anything no longer sellable', () => {
    const sellable = [offer(1), offer(2)]
    expect(chosenSaleOffers([id(2), id(9), id(1)], sellable).map((o) => o.id)).toEqual([id(2), id(1)])
    expect(chosenSaleOffers(null, sellable)).toEqual([])
  })
  it('turns an offer into plain card data that links to its /offers page', () => {
    expect(saleOfferView(offer(1, { starts_at: '2026-12-01T00:00:00Z' }), 'stillorgan', { now: NOW, formatEuro: (c) => `€${c / 100}` }))
      .toEqual({ id: id(1), name: 'Offer 1', bonus: '5 free', price: '€10', href: '/offers/stillorgan/o1', opensLabel: 'Opens soon' })
  })
})

describe('offerConfigured for a sale', () => {
  it('is ready only when it names offers and every one is sellable', () => {
    const saleOffers = [{ id: id(1) }, { id: id(2) }]
    expect(offerConfigured('sale_offers', { offer_ids: [id(1)] }, { saleOffers })).toBe(true)
    expect(offerConfigured('sale_offers', { offer_ids: [] }, { saleOffers })).toBe(false)
    expect(offerConfigured('sale_offers', { offer_ids: [id(1), id(3)] }, { saleOffers })).toBe(false)
    expect(offerConfigured('sale_offers', {}, {})).toBe(false)
  })
})
