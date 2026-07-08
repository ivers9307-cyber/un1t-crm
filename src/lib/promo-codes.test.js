// Promo code validation + discount maths (EVENTS-PROMO.1).

import { describe, it, expect } from 'vitest'
import { normalizeCode, computeDiscountCents, promoCodeError } from './promo-codes.js'

const NOW = 1_700_000_000_000

describe('normalizeCode', () => {
  it('trims + uppercases', () => {
    expect(normalizeCode('  earlybird ')).toBe('EARLYBIRD')
    expect(normalizeCode(null)).toBe('')
  })
})

describe('computeDiscountCents', () => {
  it('percent: floors to whole cents, capped at the order', () => {
    expect(computeDiscountCents({ discount_type: 'percent', discount_value: 20 }, 4500)).toBe(900)
    expect(computeDiscountCents({ discount_type: 'percent', discount_value: 33 }, 1001)).toBe(330) // floor(330.33)
    expect(computeDiscountCents({ discount_type: 'percent', discount_value: 100 }, 4500)).toBe(4500)
  })
  it('fixed: cents off, never more than the order', () => {
    expect(computeDiscountCents({ discount_type: 'fixed', discount_value: 1000 }, 4500)).toBe(1000)
    expect(computeDiscountCents({ discount_type: 'fixed', discount_value: 9999 }, 4500)).toBe(4500) // capped
  })
  it('never negative, zero order → zero, no code → zero', () => {
    expect(computeDiscountCents({ discount_type: 'fixed', discount_value: 500 }, 0)).toBe(0)
    expect(computeDiscountCents(null, 4500)).toBe(0)
    expect(computeDiscountCents({ discount_type: 'percent', discount_value: -5 }, 4500)).toBe(0)
  })
})

describe('promoCodeError', () => {
  const base = { active: true, event_id: null, member_only: false, max_redemptions: null, redeemed_count: 0, expires_at: null }

  it('accepts a valid global code', () => {
    expect(promoCodeError(base, { eventId: 'ev1', nowMs: NOW })).toBeNull()
  })
  it('rejects a missing/inactive/expired code', () => {
    expect(promoCodeError(null, {})).toMatch(/valid/)
    expect(promoCodeError({ ...base, active: false }, { nowMs: NOW })).toMatch(/active/)
    expect(promoCodeError({ ...base, expires_at: '2020-01-01T00:00:00Z' }, { nowMs: NOW })).toMatch(/expired/)
  })
  it('enforces event scope (event_id set → must match)', () => {
    expect(promoCodeError({ ...base, event_id: 'ev1' }, { eventId: 'ev2', nowMs: NOW })).toMatch(/this event/)
    expect(promoCodeError({ ...base, event_id: 'ev1' }, { eventId: 'ev1', nowMs: NOW })).toBeNull()
  })
  it('enforces member_only against a non-member order', () => {
    expect(promoCodeError({ ...base, member_only: true }, { eventId: 'ev1', nowMs: NOW, isMemberOrder: false })).toMatch(/members only/)
    expect(promoCodeError({ ...base, member_only: true }, { eventId: 'ev1', nowMs: NOW, isMemberOrder: true })).toBeNull()
  })
  it('pre-checks the redemption cap', () => {
    expect(promoCodeError({ ...base, max_redemptions: 10, redeemed_count: 10 }, { eventId: 'ev1', nowMs: NOW })).toMatch(/limit/)
    expect(promoCodeError({ ...base, max_redemptions: 10, redeemed_count: 9 }, { eventId: 'ev1', nowMs: NOW })).toBeNull()
  })
})
