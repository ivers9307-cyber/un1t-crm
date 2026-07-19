import { describe, it, expect } from 'vitest'
import { aggregateRollups } from './usage-summary.js'

describe('aggregateRollups (SAAS4-M3)', () => {
  const rows = [
    { location_id: 'a', meter: 'anthropic_tokens', quantity: 100, cost_cents: 5, locations: { name: 'Stillorgan' } },
    { location_id: 'a', meter: 'anthropic_tokens', quantity: 50, cost_cents: 2.5, locations: { name: 'Stillorgan' } },
    { location_id: 'a', meter: 'email_send', quantity: 10, cost_cents: null, locations: { name: 'Stillorgan' } },
    { location_id: 'b', meter: 'email_send', quantity: 7, cost_cents: null, locations: { name: 'Hatch' } },
  ]

  it('sums quantities and costs per meter and per location', () => {
    const { meters, byLocation } = aggregateRollups(rows)
    expect(meters.anthropic_tokens).toEqual({ quantity: 150, cost_cents: 7.5 })
    expect(meters.email_send).toEqual({ quantity: 17, cost_cents: 0 })
    expect(byLocation.a.name).toBe('Stillorgan')
    expect(byLocation.a.meters.anthropic_tokens.quantity).toBe(150)
    expect(byLocation.b.meters.email_send.quantity).toBe(7)
  })

  it('tolerates empty/absent input', () => {
    expect(aggregateRollups([])).toEqual({ meters: {}, byLocation: {} })
    expect(aggregateRollups(null)).toEqual({ meters: {}, byLocation: {} })
  })
})
