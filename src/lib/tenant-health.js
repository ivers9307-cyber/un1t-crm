// SAAS4-O4 — the master "is every tenant OK" view behind /admin/health
// (SaaS machinery plan §4). Composes signals that already exist —
// tenant_cron_health (mig 412), the integrations registry's connection
// state (INTEG-A2: channel_connections.status/last_ok_at/last_error,
// maintained by the connection-health cron), month-to-date AI cost
// (usage_rollups_daily, mig 411/415), and the live campaign backlog —
// into one org-grouped structure. Deliberately reads, never rebuilds:
// connection health is the Integrations hub's machinery.

import { dublinMonthStartStr } from '@/lib/usage-caps'

/** Pure: fold the raw signal sets into org → location rows. */
export function shapeTenantHealth({ locations, heartbeats, connections, rollups, campaigns }) {
  const backlog = {}
  for (const c of campaigns || []) {
    backlog[c.location_id] = (backlog[c.location_id] || 0) + 1
  }
  const aiCost = {}
  for (const r of rollups || []) {
    if (r.meter === 'anthropic_tokens') {
      aiCost[r.location_id] = (aiCost[r.location_id] || 0) + (Number(r.cost_cents) || 0)
    }
  }

  const orgs = new Map()
  for (const loc of locations || []) {
    const hb = (heartbeats || [])
      .filter((h) => h.location_id === loc.id)
      .map(({ name, is_stale, stale_seconds, muted }) => ({ name, is_stale, stale_seconds, muted }))
    const conns = (connections || [])
      .filter((c) => c.location_id === loc.id)
      .map(({ platform, status, last_error }) => ({ platform, status, last_error }))

    const needsAttention =
      hb.some((h) => h.is_stale && !h.muted) || conns.some((c) => c.status && c.status !== 'connected')

    const row = {
      id: loc.id,
      name: loc.name,
      heartbeats: hb,
      connections: conns,
      aiCostCentsMtd: aiCost[loc.id] || 0,
      campaignBacklog: backlog[loc.id] || 0,
      needsAttention,
    }

    const org = orgs.get(loc.organization_id) || {
      organizationId: loc.organization_id,
      name: loc.organizations?.name || loc.organization_id,
      locations: [],
      needsAttention: false,
    }
    org.locations.push(row)
    org.needsAttention = org.needsAttention || needsAttention
    orgs.set(loc.organization_id, org)
  }
  return [...orgs.values()]
}

/** Fetch + shape everything /admin/health renders. Master-only caller. */
export async function getTenantHealth(db) {
  const monthStart = dublinMonthStartStr()
  const [{ data: locations }, { data: heartbeats }, { data: connections }, { data: rollups }, { data: campaigns }] =
    await Promise.all([
      db.from('locations')
        .select('id, name, organization_id, organizations(name)')
        .eq('active', true)
        .order('name'),
      db.from('tenant_cron_health').select('name, location_id, is_stale, stale_seconds, muted'),
      db.from('channel_connections').select('location_id, platform, status, last_error'),
      db.from('usage_rollups_daily')
        .select('location_id, meter, cost_cents')
        .eq('meter', 'anthropic_tokens')
        .gte('day', monthStart),
      db.from('campaigns').select('location_id').in('status', ['queued', 'sending']),
    ])
  return shapeTenantHealth({ locations, heartbeats, connections, rollups, campaigns })
}
