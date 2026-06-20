import { describe, it, expect } from 'vitest'
import { TIERS, tierForMonths, nextTier } from './tiers.js'

describe('TIERS', () => {
  it('is the 5-rung ladder with metal colours', () => {
    expect(TIERS.map((t) => [t.slug, t.months])).toEqual([
      ['bronze', 1], ['silver', 3], ['gold', 6], ['platinum', 12], ['elite', 24],
    ])
    expect(TIERS.find((t) => t.slug === 'gold').color).toBe('#e8b931')
  })
})

describe('tierForMonths', () => {
  it('is null below Bronze', () => { expect(tierForMonths(0)).toBeNull() })
  it('maps counts to the highest reached tier', () => {
    expect(tierForMonths(1).slug).toBe('bronze')
    expect(tierForMonths(2).slug).toBe('bronze')
    expect(tierForMonths(3).slug).toBe('silver')
    expect(tierForMonths(6).slug).toBe('gold')
    expect(tierForMonths(11).slug).toBe('gold')
    expect(tierForMonths(12).slug).toBe('platinum')
    expect(tierForMonths(24).slug).toBe('elite')
    expect(tierForMonths(100).slug).toBe('elite')
  })
})

describe('nextTier', () => {
  it('points at the next rung, null at the top', () => {
    expect(nextTier(0).slug).toBe('bronze')
    expect(nextTier(1).slug).toBe('silver')
    expect(nextTier(3).slug).toBe('gold')
    expect(nextTier(6).slug).toBe('platinum')
    expect(nextTier(12).slug).toBe('elite')
    expect(nextTier(24)).toBeNull()
    expect(nextTier(100)).toBeNull()
  })
})
