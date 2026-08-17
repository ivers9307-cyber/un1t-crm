import { describe, it, expect } from 'vitest'
import { buildTrendViews, TREND_META } from './wearable-trends-view.js'

describe('wearable-trends-view', () => {
  it('groups rows by metric → display model with latest + direction + points', () => {
    const rows = [
      { metric: 'resting_heart_rate', recorded_at: '2026-06-01T00:00:00Z', value: 56, unit: 'count/min' },
      { metric: 'resting_heart_rate', recorded_at: '2026-06-20T00:00:00Z', value: 52, unit: 'count/min' },
      { metric: 'vo2_max', recorded_at: '2026-06-10T00:00:00Z', value: 47, unit: 'mL/min·kg' },
    ]
    const views = buildTrendViews(rows)
    const rhr = views.find((v) => v.metric === 'resting_heart_rate')
    expect(rhr.label).toBe('Resting heart rate')
    expect(rhr.latest).toBe(52)
    expect(rhr.direction).toBe('down')
    expect(rhr.improving).toBe(true)
    expect(rhr.points.map((p) => p.value)).toEqual([56, 52])
    expect(views.find((v) => v.metric === 'heart_rate_variability_sdnn')).toBeUndefined()
  })
  it('returns [] for no rows', () => { expect(buildTrendViews([])).toEqual([]) })
})
