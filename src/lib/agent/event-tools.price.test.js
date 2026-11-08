// TIERS.1 — Mia's price label names the tier a buyer gets now.
import { describe, it, expect } from 'vitest'
import { formatEventPrice } from './event-tools.js'

describe('formatEventPrice with tiers', () => {
  const base = { member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 3500, members_only: false }
  it('without a pricing block the mig-084 copy is unchanged', () => {
    expect(formatEventPrice(base)).toBe('€35 per person')
  })
  it('names the current tier and what follows', () => {
    const pricing = { base_cents: 3500, current: { id: 'early', name: 'Early bird', price_cents: 2500, ends_at: null, limited: true }, next: { name: 'Standard', price_cents: 3500, starts_at: null }, group: null }
    expect(formatEventPrice(base, pricing)).toBe('Early bird €25 per person (limited), then €35')
  })
  it('adds the group price when there is one', () => {
    const pricing = { base_cents: 3500, current: null, next: null, group: { min_people: 3, price_cents: 2800 } }
    expect(formatEventPrice(base, pricing)).toBe('€35 per person; 3+ people: €28 each')
  })
  it('a members-only event keeps its note', () => {
    const pricing = { base_cents: 3500, current: { id: 'e', name: 'Early bird', price_cents: 2500, ends_at: null, limited: false }, next: null, group: null }
    expect(formatEventPrice({ ...base, members_only: true }, pricing)).toBe('Early bird €25 per person (members only)')
  })
})
