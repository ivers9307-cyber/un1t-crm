// @vitest-environment jsdom
// SALEPAGE.1 — a studio's chosen offers survive the editor's string fields.
import { describe, it, expect } from 'vitest'
import { fieldsFromOffer, offerFromFields } from './studio-offer-fields.jsx'

describe('sale_offers studio fields', () => {
  it('round-trips the chosen offer ids', () => {
    const fields = fieldsFromOffer('sale_offers', { offer_ids: ['a', 'b'] })
    expect(fields).toEqual({ offer_ids: 'a,b' })
    expect(offerFromFields('sale_offers', fields)).toEqual({ offer_ids: ['a', 'b'] })
  })
  it('none chosen saves no key', () => {
    expect(offerFromFields('sale_offers', { offer_ids: '' })).toEqual({})
  })
})
