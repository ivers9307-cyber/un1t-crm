// src/lib/ads/read.test.js
import { describe, it, expect } from 'vitest'
import { shapePerAdTable } from './read.js'

describe('shapePerAdTable', () => {
  const entities = [
    { external_id: '2', name: 'testimonial', status: 'ACTIVE' }, // 0 bookings → cpa null
    { external_id: '1', name: 'schedule-fit', status: 'ACTIVE' }, // cpa 2.5
    { external_id: '3', name: 'pas-longcopy', status: 'PAUSED' }, // cpa 10
  ]
  const spendByAd = { '1': 5, '2': 10, '3': 20 }
  const bookingsByAd = { '1': 2, '2': 0, '3': 2 }
  const insightTotalsByAd = {
    '1': { impressions: 200, link_clicks: 8, landing_page_views: 6, ctr: 2.5 },
    '2': { impressions: 500, link_clicks: 10, landing_page_views: 4, ctr: 1.2 },
    '3': { impressions: 300, link_clicks: 5, landing_page_views: 3, ctr: 0.9 },
  }
  it('joins names/totals, computes cpa, sorts by cpa ascending with null cpa last', () => {
    const rows = shapePerAdTable(entities, spendByAd, bookingsByAd, insightTotalsByAd)
    // cpa: ad1=2.5, ad3=10, ad2=null → ascending, null last
    expect(rows.map((r) => r.ad_id)).toEqual(['1', '3', '2'])
    expect(rows[0]).toMatchObject({ ad_id: '1', name: 'schedule-fit', status: 'ACTIVE', spend: 5, impressions: 200, ctr: 2.5, link_clicks: 8, landing_page_views: 6, bookings: 2, cpa: 2.5 })
    expect(rows[2]).toMatchObject({ ad_id: '2', name: 'testimonial', spend: 10, bookings: 0, cpa: null })
  })
})
