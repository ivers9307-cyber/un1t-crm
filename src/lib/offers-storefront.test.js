import { describe, it, expect } from 'vitest'
import { heroFor, storefrontTitle, CATEGORY_ORDER } from './offers-storefront'
import { OFFER_SALE_TAG } from './sale-offers'

const gift = { category: 'gift_card' }
const pack = { category: 'class_pack' }
const membership = { category: 'membership' }

describe('offers storefront copy (OFFERS.8)', () => {
  it('a gift-card-only storefront gets gift copy', () => {
    const h = heroFor([gift, gift])
    expect(h.line2).toBe('OF TRAINING')
    expect(h.marquee).toMatch(/GIFT CARDS/)
  })

  it('a pack-only sale never promises a membership', () => {
    const h = heroFor([gift, pack, pack])
    expect(h.line1).toBe('LOCK IN YOUR')
    expect(h.line2).toBe('CLASSES')
    expect(h.marquee).toBe('LOCK IN YOUR CLASSES · ')
    expect(h.blurb).toMatch(/extra classes/)
    expect(h.blurb).not.toMatch(/membership|plan/i)
  })

  it('a sale with any membership keeps the membership copy', () => {
    expect(heroFor([pack, membership]).line2).toBe('MEMBERSHIP')
    expect(heroFor([membership]).line2).toBe('MEMBERSHIP')
  })

  it('an empty storefront falls back to the sale copy, not gift copy', () => {
    expect(heroFor([]).line2).toBe('MEMBERSHIP')
  })

  it('the tab title follows the same rule', () => {
    expect(storefrontTitle(new Set(['gift_card']))).toBe('Gift Cards — UN1T Stillorgan')
    expect(storefrontTitle(new Set(['gift_card', 'class_pack']))).toBe('Lock In Your Classes — UN1T Stillorgan')
    expect(storefrontTitle(new Set(['class_pack', 'membership']))).toBe('Lock In Your Membership — UN1T Stillorgan')
    expect(storefrontTitle(new Set())).toBe('Lock In Your Membership — UN1T Stillorgan')
  })

  it('timed sale sections render ahead of the evergreen gift cards', () => {
    expect(CATEGORY_ORDER).toEqual(['membership', 'class_pack', 'gift_card'])
  })

  it('a November buyer is tagged for the November sale', () => {
    expect(OFFER_SALE_TAG).toBe('offer-sale-nov-2026')
  })
})
