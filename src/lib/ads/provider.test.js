// src/lib/ads/provider.test.js
import { describe, it, expect } from 'vitest'
import { normalizeInsightRow } from './provider.js'

describe('normalizeInsightRow', () => {
  it('coerces numeric strings and defaults missing fields', () => {
    const row = normalizeInsightRow({ level: 'ad', entity_external_id: '1', date: '2026-07-03', spend: '2.30', impressions: '1039', ctr: '1.25' })
    expect(row.spend).toBe(2.3)
    expect(row.impressions).toBe(1039)
    expect(row.ctr).toBe(1.25)
    expect(row.clicks).toBe(0)
    expect(row.actions).toEqual([])
  })
  it('throws on a missing required key', () => {
    expect(() => normalizeInsightRow({ level: 'ad', date: '2026-07-03' })).toThrow(/entity_external_id/)
  })
})
