import { describe, it, expect } from 'vitest'
import { OFFERS_HOME_LOCATION_SLUG, offerBelongsToHome } from './offers-home'

describe('offers home (W0.4)', () => {
  it('the public offers surface is pinned to the Stillorgan studio', () => {
    expect(OFFERS_HOME_LOCATION_SLUG).toBe('un1t-stillorgan')
  })
  it('an offer from any other location is treated as not found', () => {
    expect(offerBelongsToHome({ location_id: 'home' }, 'home')).toBe(true)
    expect(offerBelongsToHome({ location_id: 'other' }, 'home')).toBe(false)
    expect(offerBelongsToHome({ location_id: 'home' }, null)).toBe(false)
  })
})
