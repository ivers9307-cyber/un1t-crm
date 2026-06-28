import { describe, it, expect } from 'vitest'
import {
  qualityDowngraded, tierDowngraded, tierLabel, healthDowngradeReason,
} from './whatsapp-number-health.js'

describe('qualityDowngraded', () => {
  it('true only when quality strictly worsens (GREEN>YELLOW>RED)', () => {
    expect(qualityDowngraded('GREEN', 'YELLOW')).toBe(true)
    expect(qualityDowngraded('YELLOW', 'RED')).toBe(true)
    expect(qualityDowngraded('GREEN', 'RED')).toBe(true)
  })
  it('false for same / improving / unknown', () => {
    expect(qualityDowngraded('GREEN', 'GREEN')).toBe(false)
    expect(qualityDowngraded('RED', 'GREEN')).toBe(false)       // recovery, not a drop
    expect(qualityDowngraded(null, 'RED')).toBe(false)          // first seed isn't a drop
    expect(qualityDowngraded('GREEN', 'UNKNOWN')).toBe(false)   // unranked → don't alert
    expect(qualityDowngraded(undefined, undefined)).toBe(false)
  })
})

describe('tierDowngraded', () => {
  it('true when the messaging tier drops', () => {
    expect(tierDowngraded('TIER_10K', 'TIER_1K')).toBe(true)
    expect(tierDowngraded('UNLIMITED', 'TIER_100K')).toBe(true)
  })
  it('false for same / upgrade / unknown', () => {
    expect(tierDowngraded('TIER_1K', 'TIER_1K')).toBe(false)
    expect(tierDowngraded('TIER_1K', 'TIER_10K')).toBe(false)
    expect(tierDowngraded(null, 'TIER_1K')).toBe(false)
  })
})

describe('tierLabel', () => {
  it('maps Meta tiers to operator-facing daily limits', () => {
    expect(tierLabel('TIER_1K')).toBe('1,000 / day')
    expect(tierLabel('UNLIMITED')).toBe('Unlimited')
    expect(tierLabel(null)).toBe('—')
  })
})

describe('healthDowngradeReason', () => {
  it('reports a quality drop', () => {
    expect(healthDowngradeReason(
      { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' },
      { quality_rating: 'YELLOW', messaging_limit_tier: 'TIER_1K' },
    )).toBe('quality dropped GREEN → YELLOW')
  })
  it('reports a tier downgrade when quality is unchanged', () => {
    expect(healthDowngradeReason(
      { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_10K' },
      { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' },
    )).toBe('messaging limit lowered 10,000 / day → 1,000 / day')
  })
  it('returns null when nothing worsened (incl. first seed from null)', () => {
    expect(healthDowngradeReason(
      { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' },
      { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' },
    )).toBe(null)
    expect(healthDowngradeReason(
      { quality_rating: null, messaging_limit_tier: null },
      { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' },
    )).toBe(null)
  })
})
