// src/lib/ads/sync.js
// Orchestrate one account's sync: entities + daily insights (+ breakdowns).
// db + provider are injected so this is unit-testable with no network/DB.
const LEVELS = ['campaign', 'adset', 'ad']

function stamp(account, row) {
  return { location_id: account.location_id, ad_account_id: account.id, provider: account.provider, ...row }
}

export async function syncAccount(db, account, provider, { since, until, breakdowns = [] }) {
  // Entities
  const entities = await provider.listEntities(account)
  if (entities.length) {
    await db.from('ad_entities').upsert(
      entities.map((e) => stamp(account, { level: e.level, external_id: e.external_id, name: e.name, status: e.status, campaign_external_id: e.campaign_external_id, adset_external_id: e.adset_external_id, raw: e.raw, updated_at: new Date().toISOString() })),
      { onConflict: 'ad_account_id,level,external_id' },
    )
  }
  // Daily insights per level
  for (const level of LEVELS) {
    const rows = await provider.fetchInsights(account, { since, until, level })
    if (rows.length) {
      await db.from('ad_insights_daily').upsert(
        rows.map((r) => stamp(account, { level: r.level, entity_external_id: r.entity_external_id, date: r.date, spend: r.spend, impressions: r.impressions, reach: r.reach, frequency: r.frequency, clicks: r.clicks, link_clicks: r.link_clicks, landing_page_views: r.landing_page_views, ctr: r.ctr, cpc: r.cpc, cpm: r.cpm, results: r.results, result_type: r.result_type, actions: r.actions, synced_at: new Date().toISOString() })),
        { onConflict: 'ad_account_id,level,entity_external_id,date' },
      )
    }
  }
  // Breakdowns (ad level only)
  for (const breakdown of breakdowns) {
    const rows = await provider.fetchInsights(account, { since, until, level: 'ad', breakdown })
    if (rows.length) {
      await db.from('ad_insights_breakdown_daily').upsert(
        rows.map((r) => stamp(account, { level: 'ad', entity_external_id: r.entity_external_id, date: r.date, dimension: r.dimension, segment: r.segment, spend: r.spend, impressions: r.impressions, clicks: r.clicks, link_clicks: r.link_clicks, results: r.results, actions: r.actions, synced_at: new Date().toISOString() })),
        { onConflict: 'ad_account_id,level,entity_external_id,date,dimension,segment' },
      )
    }
  }
}
