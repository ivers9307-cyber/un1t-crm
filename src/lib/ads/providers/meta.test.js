// src/lib/ads/providers/meta.test.js
import { describe, it, expect } from 'vitest'
import { mapMetaInsight, mapMetaEntity, extractAction } from './meta.js'

describe('extractAction', () => {
  it('pulls a value from the actions array by type', () => {
    const actions = [{ action_type: 'link_click', value: '7' }, { action_type: 'landing_page_view', value: '5' }]
    expect(extractAction(actions, 'landing_page_view')).toBe(5)
    expect(extractAction(actions, 'purchase')).toBe(0)
  })
})

describe('mapMetaInsight', () => {
  it('maps a Graph ad-level insight row to the normalized shape', () => {
    const raw = {
      ad_id: '120248413617870055', date_start: '2026-07-03', date_stop: '2026-07-03',
      spend: '2.30', impressions: '1039', reach: '1000', frequency: '1.04',
      clicks: '13', ctr: '1.25', cpc: '0.33', cpm: '2.21',
      actions: [{ action_type: 'link_click', value: '7' }, { action_type: 'landing_page_view', value: '8' }],
    }
    const out = mapMetaInsight(raw, 'ad')
    expect(out.level).toBe('ad')
    expect(out.entity_external_id).toBe('120248413617870055')
    expect(out.date).toBe('2026-07-03')
    expect(out.spend).toBe(2.3)
    expect(out.link_clicks).toBe(7)
    expect(out.landing_page_views).toBe(8)
  })
})

describe('mapMetaEntity', () => {
  it('maps a Graph ad object to an ad_entities row', () => {
    const raw = { id: '120248413617870055', name: 'testimonial-vicky', effective_status: 'ACTIVE', campaign_id: 'c1', adset_id: 'a1' }
    const out = mapMetaEntity(raw, 'ad')
    expect(out).toMatchObject({ level: 'ad', external_id: '120248413617870055', name: 'testimonial-vicky', status: 'ACTIVE', campaign_external_id: 'c1', adset_external_id: 'a1' })
  })
})
