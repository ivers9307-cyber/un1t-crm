import { describe, it, expect } from 'vitest'
import {
  MOBILE_NAV_FEATURES, BAR_ELIGIBLE, DEFAULT_MOBILE_LAYOUT, MOBILE_NAV_ORDER,
} from './mobile-nav.js'

describe('mobile-nav registry', () => {
  it('every feature has key/label/permKeys/barEligible', () => {
    for (const f of MOBILE_NAV_FEATURES) {
      expect(typeof f.key).toBe('string')
      expect(typeof f.label).toBe('string')
      expect(Array.isArray(f.permKeys) && f.permKeys.length > 0).toBe(true)
      expect(typeof f.barEligible).toBe('boolean')
    }
  })

  it('BAR_ELIGIBLE is exactly the bar-eligible keys', () => {
    expect([...BAR_ELIGIBLE].sort()).toEqual(
      ['bookings', 'expenses', 'invoices', 'pipeline', 'schedule', 'studio', 'whatsapp'].sort()
    )
  })

  it('keys are unique and MOBILE_NAV_ORDER matches', () => {
    const keys = MOBILE_NAV_FEATURES.map(f => f.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(MOBILE_NAV_ORDER).toEqual(keys)
  })

  it('every role default references only known + bar-eligible keys', () => {
    const eligible = new Set(BAR_ELIGIBLE)
    for (const role of Object.keys(DEFAULT_MOBILE_LAYOUT)) {
      for (const type of ['fte', 'contractor']) {
        const t = DEFAULT_MOBILE_LAYOUT[role][type]
        for (const k of [...t.bar, ...t.allowed]) expect(eligible.has(k)).toBe(true)
        expect(t.bar.length).toBeLessThanOrEqual(3)
      }
    }
  })
})
