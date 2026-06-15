import { describe, it, expect } from 'vitest'
import { sortGoals, latestScan, scanSeries } from './consultations-view'

describe('sortGoals', () => {
  it('orders open first, then by created_at desc within status', () => {
    const g = [
      { id: 'a', status: 'achieved', created_at: '2026-01-01' },
      { id: 'b', status: 'open', created_at: '2026-02-01' },
      { id: 'c', status: 'open', created_at: '2026-03-01' },
    ]
    expect(sortGoals(g).map((x) => x.id)).toEqual(['c', 'b', 'a'])
  })
  it('handles empty/undefined', () => {
    expect(sortGoals([])).toEqual([])
    expect(sortGoals(undefined)).toEqual([])
  })
})

describe('latestScan', () => {
  it('returns the most recent by scanned_at, null when empty', () => {
    expect(latestScan([])).toBeNull()
    expect(latestScan(undefined)).toBeNull()
    const s = [{ scanned_at: '2024-01-01', weight_kg: 80 }, { scanned_at: '2026-06-01', weight_kg: 75 }]
    expect(latestScan(s).weight_kg).toBe(75)
  })
})

describe('scanSeries', () => {
  it('builds an ascending {x,y} series for a metric, skipping null y', () => {
    const s = [
      { scanned_at: '2026-06-01', pbf_percent: 22 },
      { scanned_at: '2026-01-01', pbf_percent: null },
      { scanned_at: '2026-03-01', pbf_percent: 25 },
    ]
    expect(scanSeries(s, 'pbf_percent')).toEqual([
      { x: '2026-03-01', y: 25 },
      { x: '2026-06-01', y: 22 },
    ])
  })
  it('returns [] for empty/undefined', () => {
    expect(scanSeries(undefined, 'weight_kg')).toEqual([])
  })
})
