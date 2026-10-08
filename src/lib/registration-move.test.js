import { describe, it, expect } from 'vitest'
import { entryLabel, entryHeadcount, computePriceGapCents } from './registration-move.js'

describe('entryLabel', () => {
  it('names a team of two or more by the team name', () => {
    expect(entryLabel({ teams: { name: 'The Crushers', team_members: [{ name: 'A' }, { name: 'B' }] } })).toBe('The Crushers')
  })
  it('names a team of one by the person, not the team', () => {
    expect(entryLabel({ teams: { name: 'Mark Kelly', team_members: [{ name: 'Mark Kelly', role: 'captain' }] } })).toBe('Mark Kelly')
  })
  it('names a team-less entry by its lead contact', () => {
    expect(entryLabel({ teams: null, contact: { first_name: 'Aoife', last_name: 'Byrne' } })).toBe('Aoife Byrne')
  })
  it('falls back to "Entry" when nothing is known', () => {
    expect(entryLabel({})).toBe('Entry')
  })
})

describe('entryHeadcount', () => {
  it('counts the team members', () => {
    expect(entryHeadcount({ teams: { size: 4, team_members: [{}, {}] } })).toBe(2)
  })
  it('falls back to teams.size when members are not loaded', () => {
    expect(entryHeadcount({ teams: { size: 3 } })).toBe(3)
  })
  it('is 1 for a team-less entry', () => {
    expect(entryHeadcount({ teams: null })).toBe(1)
    expect(entryHeadcount({})).toBe(1)
  })
})

describe('computePriceGapCents', () => {
  const source = { member_pricing_enabled: true, member_fee_cents: 2000, non_member_fee_cents: 3000 }
  const target = { member_pricing_enabled: true, member_fee_cents: 2500, non_member_fee_cents: 3500 }
  it('charges the member rate for members and the non-member rate otherwise', () => {
    const members = [{ is_member: true }, { is_member: false }]
    expect(computePriceGapCents({ sourceEvent: source, targetEvent: target, members })).toBe(500 + 500)
  })
  it('is negative when the target is cheaper', () => {
    expect(computePriceGapCents({ sourceEvent: target, targetEvent: source, members: [{ is_member: false }] })).toBe(-500)
  })
  it('uses the non-member rate for everyone when member pricing is off', () => {
    const t = { member_pricing_enabled: false, member_fee_cents: 0, non_member_fee_cents: 3500 }
    expect(computePriceGapCents({ sourceEvent: source, targetEvent: t, members: [{ is_member: true }] })).toBe(1500)
  })
  it('treats a missing fee as free', () => {
    expect(computePriceGapCents({ sourceEvent: {}, targetEvent: target, members: [{ is_member: false }] })).toBe(3500)
  })
  it('counts one person for a team-less entry', () => {
    expect(computePriceGapCents({ sourceEvent: source, targetEvent: target, members: [] })).toBe(500)
  })
})
