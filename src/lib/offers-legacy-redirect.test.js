import { describe, it, expect } from 'vitest'
import { legacyOfferRedirect } from './offers-legacy-redirect'

describe('legacyOfferRedirect', () => {
  it('legacy slug redirects with purchase', () => {
    expect(legacyOfferRedirect('30-class-pack', 'abc')).toBe('/offers/stillorgan/30-class-pack?purchase=abc')
  })

  it('has no query string without a purchase', () => {
    expect(legacyOfferRedirect('30-class-pack', null)).toBe('/offers/stillorgan/30-class-pack')
    expect(legacyOfferRedirect('30-class-pack', '')).toBe('/offers/stillorgan/30-class-pack')
    expect(legacyOfferRedirect('30-class-pack')).toBe('/offers/stillorgan/30-class-pack')
  })

  it('encodes the purchase value', () => {
    expect(legacyOfferRedirect('gift', 'a b&c=d')).toBe('/offers/stillorgan/gift?purchase=a%20b%26c%3Dd')
  })
})
