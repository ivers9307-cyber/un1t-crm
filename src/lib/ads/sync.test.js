// src/lib/ads/sync.test.js
import { describe, it, expect } from 'vitest'
import { syncAccount } from './sync.js'

function fakeDb() {
  const upserts = {}
  return {
    upserts,
    from(table) {
      return {
        upsert(rows) { upserts[table] = (upserts[table] || []).concat(rows); return { select: () => ({ then: (r) => r({ data: rows }) }) } },
        update() { return { eq: () => ({ then: (r) => r({ data: [] }) }) } },
      }
    },
  }
}

const fakeProvider = {
  listEntities: async () => [{ level: 'ad', external_id: '1', name: 'A', status: 'ACTIVE', raw: {} }],
  fetchInsights: async (account, { level }) => [{ level, entity_external_id: '1', date: '2026-07-03', spend: 2, impressions: 100, reach: 90, frequency: 1, clicks: 3, link_clicks: 2, landing_page_views: 2, ctr: 3, cpc: 0.6, cpm: 20, results: 2, result_type: 'landing_page_view', actions: [] }],
}

describe('syncAccount', () => {
  it('upserts entities and daily insights stamped with location_id', async () => {
    const db = fakeDb()
    const account = { id: 'acc1', location_id: 'loc1', provider: 'meta', external_account_id: '900' }
    await syncAccount(db, account, fakeProvider, { since: '2026-07-01', until: '2026-07-03', breakdowns: [] })
    expect(db.upserts.ad_entities[0]).toMatchObject({ location_id: 'loc1', ad_account_id: 'acc1', level: 'ad', external_id: '1' })
    const adRow = db.upserts.ad_insights_daily.find((r) => r.level === 'ad')
    expect(adRow).toMatchObject({ location_id: 'loc1', ad_account_id: 'acc1', level: 'ad', entity_external_id: '1', date: '2026-07-03', spend: 2 })
  })
})
