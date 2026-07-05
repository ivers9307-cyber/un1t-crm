// shared/dashboard-metrics.js
//
// DASH-REBUILD — pure shaping helpers for the Business dashboard
// blocks. No DB, no platform imports.

export const FUNNEL_SLUGS = Object.freeze([
  'new_lead', 'first_class', 'second_class', 'trial_done', 'converted',
])

export function pctDelta(current, previous) {
  if (!previous || previous <= 0) return null
  return ((current - previous) / previous) * 100
}

// ad_insights_daily stores campaign AND adset AND ad rows for the same
// day — summing without a level filter triple-counts spend.
export function sumCampaignRows(rows = []) {
  let spend = 0
  let results = 0
  for (const r of rows) {
    if (r.level !== 'campaign') continue
    spend += Number(r.spend) || 0
    results += Number(r.results) || 0
  }
  return { spend, results }
}

export function shapeFunnel(countsBySlug = {}, month = { entered: 0, converted: 0 }) {
  const stages = FUNNEL_SLUGS.map(slug => ({ slug, count: countsBySlug[slug] || 0 }))
  const conversionPct = month.entered > 0
    ? Math.round((month.converted / month.entered) * 100)
    : null
  return { stages, entered: month.entered || 0, converted: month.converted || 0, conversionPct }
}
