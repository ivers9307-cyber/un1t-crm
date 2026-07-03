// src/lib/ads/provider.js
// The contract every ads provider implements:
//   listEntities(account) -> [{ level, external_id, name, status, campaign_external_id?, adset_external_id?, raw }]
//   fetchInsights(account, { since, until, level, breakdown? }) -> [normalizeInsightRow shape]
// This module owns the normalized row shape so downstream code is provider-agnostic.

const NUM = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v))

export function normalizeInsightRow(r) {
  for (const k of ['level', 'entity_external_id', 'date']) {
    if (!r[k]) throw new Error(`normalizeInsightRow: missing ${k}`)
  }
  return {
    level: r.level,
    entity_external_id: String(r.entity_external_id),
    date: r.date,
    spend: NUM(r.spend),
    impressions: NUM(r.impressions),
    reach: NUM(r.reach),
    frequency: NUM(r.frequency),
    clicks: NUM(r.clicks),
    link_clicks: NUM(r.link_clicks),
    landing_page_views: NUM(r.landing_page_views),
    ctr: NUM(r.ctr),
    cpc: NUM(r.cpc),
    cpm: NUM(r.cpm),
    results: NUM(r.results),
    result_type: r.result_type || null,
    actions: Array.isArray(r.actions) ? r.actions : [],
    dimension: r.dimension || null,
    segment: r.segment || null,
  }
}
