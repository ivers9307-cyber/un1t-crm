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

  const copy = { marquee: 'M · ', line1: 'L1', line2: 'L2', blurb: 'B' }

  it('gift-only keeps the gift hero, with the studio in the title', () => {
    expect(heroFor([gift], copy).line1).toBe('GIVE THE GIFT')
    expect(heroFor([gift], copy, 'UN1T Hatch Street').title).toBe('Gift Cards — UN1T Hatch Street')
  })

  it('any timed sale reads from the studio copy', () => {
    const h = heroFor([gift, pack, pack], copy, 'UN1T Hatch Street')
    expect(h).toEqual({ marquee: 'M · ', line1: 'L1', line2: 'L2', blurb: 'B', title: 'Black Friday — UN1T Hatch Street' })
    expect(heroFor([pack], copy).line2).toBe(copy.line2)
    expect(heroFor([membership], copy).line2).toBe(copy.line2)
  })

  it('copy is optional and defaults to the Black Friday head start', () => {
    expect(heroFor([membership]).line2).toBe('HEAD START')
    expect(heroFor([]).line2).toBe('HEAD START')
  })

  it('the tab title follows the same rule', () => {
    expect(storefrontTitle(new Set(['gift_card']))).toBe('Gift Cards — UN1T Stillorgan')
    expect(storefrontTitle(new Set(['gift_card', 'class_pack']))).toBe('Black Friday — UN1T Stillorgan')
    expect(storefrontTitle(new Set(), 'UN1T Hatch Street')).toBe('Black Friday — UN1T Hatch Street')
  })

  it('timed sale sections render ahead of the evergreen gift cards', () => {
    expect(CATEGORY_ORDER).toEqual(['membership', 'class_pack', 'gift_card'])
  })

  it('a Black Friday buyer is tagged for the Black Friday sale', () => {
    expect(OFFER_SALE_TAG).toBe('offer-sale-bf-2026')
  })
})
