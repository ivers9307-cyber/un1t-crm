// HOSTPORTAL.2 — the one-line "price right now" summary on the Overview tab.
// Tiers use the shapes of pricing-tiers.test.js.
import { describe, it, expect } from 'vitest'
import { hostPriceLine } from './host-price-line'

const nowMs = Date.parse('2026-11-15T12:00:00Z')
const zone = 'Europe/Dublin'
const earlyBird = { id: 'early', name: 'Early bird', price_cents: 2500, capacity: 20 }
const group3 = { id: 'group', name: 'Groups', price_cents: 2800, min_people: 3 }
const raceWith = (tiers, base = 3500) => ({ id: 'e1', non_member_fee_cents: base, pricing_tiers: tiers })

describe('hostPriceLine', () => {
  it('names the open tier, what is left, the standard price and the group price', () => {
    // The group tier is listed before the early bird, so a party of 3 gets it.
    expect(hostPriceLine({ race: raceWith([group3, earlyBird]), soldByTier: { early: 14 }, nowMs, zone }))
      .toBe('Early bird €25 · 6 of 20 left · then standard €35 · 3 or more people €28 each')
  })

  it('leaves the group price out while an earlier tier is what a group would pay', () => {
    expect(hostPriceLine({ race: raceWith([earlyBird, group3]), soldByTier: { early: 14 }, nowMs, zone }))
      .toBe('Early bird €25 · 6 of 20 left · then standard €35')
  })

  it('skips a sold-out tier and starts with the standard price', () => {
    expect(hostPriceLine({ race: raceWith([earlyBird]), soldByTier: { early: 20 }, nowMs, zone }))
      .toBe('€35 per person')
  })

  it('keeps the group price when the early tier is sold out', () => {
    expect(hostPriceLine({ race: raceWith([earlyBird, group3]), soldByTier: { early: 20 }, nowMs, zone }))
      .toBe('€35 per person · 3 or more people €28 each')
  })

  it('says Free for a €0 event with no tiers, and for a null price', () => {
    expect(hostPriceLine({ race: raceWith([], 0), soldByTier: {}, nowMs, zone })).toBe('Free')
    expect(hostPriceLine({ race: raceWith(null, null), soldByTier: {}, nowMs, zone })).toBe('Free')
  })

  it('shows the standard price alone when there are no tiers', () => {
    expect(hostPriceLine({ race: raceWith([]), soldByTier: {}, nowMs, zone })).toBe('€35 per person')
  })

  it('keeps cents when the price is not a whole euro', () => {
    expect(hostPriceLine({ race: raceWith([], 3550), soldByTier: {}, nowMs, zone })).toBe('€35.50 per person')
  })

  it('shows a tier with no capacity without a "left" part', () => {
    const dec = { id: 'dec', name: 'Before December', price_cents: 3000, ends_at: '2026-12-01T00:00:00Z' }
    expect(hostPriceLine({ race: raceWith([dec]), soldByTier: {}, nowMs, zone }))
      .toBe('Before December €30 · then standard €35')
  })

  it('says "then" with the next tier when there is one, not the standard price', () => {
    const second = { id: 'second', name: 'Second release', price_cents: 3000 }
    expect(hostPriceLine({ race: raceWith([earlyBird, second]), soldByTier: { early: 14 }, nowMs, zone }))
      .toBe('Early bird €25 · 6 of 20 left · then Second release €30')
  })

  it('lists only the group tier that is open, not an ended one', () => {
    const ended = { id: 'g', name: 'Groups', price_cents: 2800, min_people: 3, ends_at: '2026-11-01T00:00:00Z' }
    expect(hostPriceLine({ race: raceWith([earlyBird, ended]), soldByTier: { early: 14 }, nowMs, zone }))
      .toBe('Early bird €25 · 6 of 20 left · then standard €35')
  })

  it('says "then free" when a tier is open and the standard price is 0', () => {
    expect(hostPriceLine({ race: raceWith([earlyBird], 0), soldByTier: {}, nowMs, zone }))
      .toBe('Early bird €25 · 20 of 20 left · then free')
  })

  it('counts what is left from the people sold', () => {
    const tight = { id: 't', name: 'Tight', price_cents: 1000, capacity: 5 }
    expect(hostPriceLine({ race: raceWith([tight]), soldByTier: { t: 4 }, nowMs, zone })).toContain('1 of 5 left')
  })
})
