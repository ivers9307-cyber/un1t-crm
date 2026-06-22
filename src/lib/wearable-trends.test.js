import { describe, it, expect } from 'vitest'
import { TREND_METRICS, samplesToMetricRows } from './wearable-trends.js'

describe('wearable-trends', () => {
  it('exposes the three OW series types we ingest', () => {
    expect(TREND_METRICS).toEqual(['resting_heart_rate', 'heart_rate_variability_sdnn', 'vo2_max'])
  })
  it('maps OW samples → member_health_metrics rows, dropping junk + deduping', () => {
    const rows = samplesToMetricRows({
      contactId: 'c1', locationId: 'loc1',
      samples: [
        { type: 'resting_heart_rate', timestamp: '2026-06-20T00:00:00Z', value: 52, unit: 'count/min' },
        { type: 'resting_heart_rate', timestamp: '2026-06-20T00:00:00Z', value: 52, unit: 'count/min' },
        { type: 'vo2_max', timestamp: '2026-06-21T00:00:00Z', value: '48.2', unit: 'mL/min·kg' },
        { type: 'resting_heart_rate', timestamp: 'bad', value: 50 },
        { type: 'steps', timestamp: '2026-06-20T00:00:00Z', value: 9000 },
        { type: 'vo2_max', timestamp: '2026-06-22T00:00:00Z', value: null },
      ],
    })
    expect(rows).toEqual([
      { contact_id: 'c1', location_id: 'loc1', metric: 'resting_heart_rate', recorded_at: '2026-06-20T00:00:00.000Z', value: 52, unit: 'count/min', source: 'apple_health' },
      { contact_id: 'c1', location_id: 'loc1', metric: 'vo2_max', recorded_at: '2026-06-21T00:00:00.000Z', value: 48.2, unit: 'mL/min·kg', source: 'apple_health' },
    ])
  })
})
