// shared/dashboard-metrics.test.js
import { describe, it, expect } from 'vitest'
import { pctDelta, sumCampaignRows, shapeFunnel, FUNNEL_SLUGS } from './dashboard-metrics.js'

describe('pctDelta', () => {
  it('computes percent change', () => { expect(pctDelta(110, 100)).toBeCloseTo(10) })
  it('null when previous is 0 or missing', () => {
    expect(pctDelta(50, 0)).toBe(null)
    expect(pctDelta(50, null)).toBe(null)
  })
})

describe('sumCampaignRows', () => {
  const rows = [
    { level: 'campaign', spend: '10.50', results: 3 },
    { level: 'campaign', spend: '4.50', results: 1 },
    { level: 'ad', spend: '99', results: 99 },
  ]
  it('sums spend and results at campaign level only', () => {
    expect(sumCampaignRows(rows)).toEqual({ spend: 15, results: 4 })
  })
  it('handles empty input', () => {
    expect(sumCampaignRows([])).toEqual({ spend: 0, results: 0 })
  })
})

describe('shapeFunnel', () => {
  it('orders counts by the canonical slug order and computes conversion', () => {
    const shaped = shapeFunnel(
      { new_lead: 30, first_class: 12, second_class: 8, trial_done: 6, converted: 5 },
      { entered: 61, converted: 10 },
    )
    expect(shaped.stages.map(s => s.slug)).toEqual([...FUNNEL_SLUGS])
    expect(shaped.stages[0].count).toBe(30)
    expect(shaped.conversionPct).toBe(16)
  })
  it('null conversion when nothing entered', () => {
    expect(shapeFunnel({}, { entered: 0, converted: 0 }).conversionPct).toBe(null)
  })
})
