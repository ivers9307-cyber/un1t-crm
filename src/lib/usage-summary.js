// SAAS4-M3 — org usage summary shared by /api/settings/org-usage and
// the /settings/usage page (one query/aggregation path, two callers).

import { dublinMonthStartStr } from '@/lib/usage-caps'

/** Pure: fold month rollup rows into per-meter + per-location totals. */
export function aggregateRollups(rows) {
  const meters = {}
  const byLocation = {}
  for (const row of rows || []) {
    const m = (meters[row.meter] ||= { quantity: 0, cost_cents: 0 })
    m.quantity += Number(row.quantity) || 0
    m.cost_cents += Number(row.cost_cents) || 0
    const loc = (byLocation[row.location_id] ||= { name: row.locations?.name || row.location_id, meters: {} })
    const lm = (loc.meters[row.meter] ||= { quantity: 0, cost_cents: 0 })
    lm.quantity += Number(row.quantity) || 0
    lm.cost_cents += Number(row.cost_cents) || 0
  }
  return { meters, byLocation }
}

// Month rollups can exceed the PostgREST 1k cap for larger orgs
// (locations × 4 meters × ≤31 days) — .range()-paginate with an
// explicit order (the pipeline-reclassify pattern).
async function fetchMonthRollups(db, orgId, monthStart) {
  const PAGE = 1000
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data } = await db
      .from('usage_rollups_daily')
      .select('location_id, meter, day, quantity, cost_cents, locations(name)')
      .eq('organization_id', orgId)
      .gte('day', monthStart)
      .order('day', { ascending: true })
      .order('location_id', { ascending: true })
      .order('meter', { ascending: true })
      .range(from, from + PAGE - 1)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

/**
 * Full month-to-date summary for one org: live cap-relevant numbers
 * (mig 415 RPCs) + nightly rollup totals + the configured hard caps.
 */
export async function getOrgUsageSummary(db, orgId) {
  const monthStart = dublinMonthStartStr()

  const [{ data: settings }, { data: aiSpend }, { data: emailSends }, rollups] =
    await Promise.all([
      db.from('org_settings')
        .select('ai_hard_cap_cents, email_hard_cap_sends, ai_cap_notice_month, email_cap_notice_month')
        .eq('organization_id', orgId)
        .maybeSingle(),
      db.rpc('org_ai_spend_month_cents', { p_org: orgId, p_month_start: monthStart }),
      db.rpc('org_email_sends_month', { p_org: orgId, p_month_start: monthStart }),
      fetchMonthRollups(db, orgId, monthStart),
    ])

  const { meters, byLocation } = aggregateRollups(rollups || [])
  return {
    organization_id: orgId,
    month_start: monthStart,
    live: {
      ai_spend_cents: Number(aiSpend) || 0,
      email_sends: Number(emailSends) || 0,
    },
    caps: {
      ai_hard_cap_cents: settings?.ai_hard_cap_cents ?? null,
      email_hard_cap_sends: settings?.email_hard_cap_sends ?? null,
    },
    meters,
    by_location: byLocation,
  }
}
