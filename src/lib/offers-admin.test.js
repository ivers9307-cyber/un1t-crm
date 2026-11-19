// OFFERSEDIT.1 — the editor's rules: an active offer must be sellable.
import { describe, it, expect } from 'vitest'
import { offerSaleProblems, slugFromName, offerCreateSchema, offerUpdateSchema } from './offers-admin.js'

const UN1T = { membership_source: 'un1t_online' }
const GLOFOX = { membership_source: 'glofox' }
const codes = (p) => p.map((x) => x.code)

describe('offerSaleProblems', () => {
  it('a Revolut offer with no product is fine', () => {
    expect(offerSaleProblems(GLOFOX, { category: 'class_pack', price_cents: 1000 }, null)).toEqual([])
    expect(offerSaleProblems(UN1T, { category: 'gift_card', price_cents: 1000 }, null)).toEqual([])
  })
  it('a un1t.online pack needs its product, in the mirror, at the same price', () => {
    expect(codes(offerSaleProblems(UN1T, { category: 'class_pack', price_cents: 1000 }, null))).toEqual(['not_configured'])
    expect(codes(offerSaleProblems(UN1T, { category: 'class_pack', un1t_product_id: 'p1', price_cents: 1000 }, null))).toEqual(['product_missing'])
    expect(codes(offerSaleProblems(UN1T, { category: 'class_pack', un1t_product_id: 'p1', price_cents: 1000 }, { price_cents: 900 }))).toEqual(['price_mismatch'])
    expect(offerSaleProblems(UN1T, { category: 'membership', un1t_product_id: 'p1', price_cents: 1000 }, { price_cents: 1000 })).toEqual([])
  })
  it('a product id where the card checkout sells is refused', () => {
    expect(codes(offerSaleProblems(GLOFOX, { category: 'class_pack', un1t_product_id: 'p1', price_cents: 1000 }, null))).toEqual(['not_configured'])
  })
})

describe('slugFromName', () => {
  it('makes a web address from the name', () => {
    expect(slugFromName('30 + 10 Pack!')).toBe('30-10-pack')
    expect(slugFromName('Café Été')).toBe('cafe-ete')
    expect(slugFromName('!!!')).toBe('offer')
  })
})

describe('schemas', () => {
  const ok = { name: 'Pack', category: 'class_pack', bonus_headline: '10 free', price_cents: 1000 }
  it('create fills safe defaults: inactive, no end, no limit', () => {
    expect(offerCreateSchema.parse(ok)).toMatchObject({ active: false, ends_at: null, stock_limit: null, un1t_product_id: null, sort: 0 })
  })
  it('refuses an end before the start, a zero price, an unknown kind', () => {
    expect(offerCreateSchema.safeParse({ ...ok, starts_at: '2026-12-02T00:00:00Z', ends_at: '2026-12-01T00:00:00Z' }).success).toBe(false)
    expect(offerCreateSchema.safeParse({ ...ok, price_cents: 0 }).success).toBe(false)
    expect(offerCreateSchema.safeParse({ ...ok, category: 'raffle' }).success).toBe(false)
  })
  it('an edit cannot change the web address', () => {
    expect(offerUpdateSchema.parse({ slug: 'new', name: 'X' })).toEqual({ name: 'X' })
  })
})
