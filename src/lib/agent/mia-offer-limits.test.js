import { describe, it, expect } from 'vitest'
import { isSellableUn1tProduct } from './mia-offer-limits'
import { UN1T_PRODUCT_ACTIVE_STATUS } from './un1t-tools'

describe('isSellableUn1tProduct', () => {
  it('is active with a whole-cent price above zero', () => {
    expect(isSellableUn1tProduct({ status: UN1T_PRODUCT_ACTIVE_STATUS, price_cents: 1500 })).toBe(true)
  })
  it('refuses inactive, free, null, fractional and missing', () => {
    expect(isSellableUn1tProduct({ status: 'inactive', price_cents: 1500 })).toBe(false)
    expect(isSellableUn1tProduct({ status: 'active', price_cents: 0 })).toBe(false)
    expect(isSellableUn1tProduct({ status: 'active', price_cents: -5 })).toBe(false)
    expect(isSellableUn1tProduct({ status: 'active', price_cents: null })).toBe(false)
    expect(isSellableUn1tProduct({ status: 'active', price_cents: 12.5 })).toBe(false)
    expect(isSellableUn1tProduct(null)).toBe(false)
  })
})
