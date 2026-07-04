// src/lib/dashboard/business-rail.js
//
// DASH-REBUILD — assembles the Business dashboard "Needs you" rail.
// Fixed category order: approvals, failed, arrears, churn, leads.
// Categories with zero items are omitted. Web-only (imports the
// approvals registry + radar snapshots), so it lives in src/lib, not
// shared/. Every row: { key, chip, tone, text, href }.
// tone ∈ 'purple' | 'red' | 'amber' | 'teal' — mapped to chip classes
// in the component, not here.

import { getPendingApprovalsCount } from '@/lib/approvals/registry'
import { fetchArrearsSummary } from '@shared/dashboard-data'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export async function buildNeedsYouRail(db, user, locationId, now = new Date()) {
  const rows = []

  // 1. Pending approvals — registry total across visible providers.
  try {
    const count = await getPendingApprovalsCount(db, user)
    if (count > 0) {
      rows.push({
        key: 'approvals', chip: 'Approval', tone: 'purple',
        text: `${count} pending approval${count === 1 ? '' : 's'}`,
        href: '/approvals',
      })
    }
  } catch { /* row omitted on failure */ }

  // 2. Failed agent executions, last 7 days. No dismiss in v1 — rows
  // age out of the window (spec).
  try {
    const sinceIso = new Date(now.getTime() - WEEK_MS).toISOString()
    const { data } = await db.from('agent_membership_requests')
      .select('id, kind, conversation_id, channel, contacts(first_name, name)')
      .eq('location_id', locationId).eq('status', 'failed')
      .gte('decided_at', sinceIso)
      .order('decided_at', { ascending: false }).limit(20)
    if (data && data.length) {
      const first = data[0]
      const who = first.contacts?.first_name || first.contacts?.name || 'a member'
      const more = data.length > 1 ? ` (+${data.length - 1} more)` : ''
      const href = first.conversation_id
        ? `/communications/inbox?c=${first.conversation_id}&ch=${first.channel === 'instagram' ? 'ig' : 'wa'}`
        : '/settings/customer-agent/requests'
      rows.push({
        key: 'failed', chip: 'Failed', tone: 'red',
        text: `Glofox action failed for ${who}${more}`,
        href,
      })
    }
  } catch { /* omitted */ }

  // 3. Arrears — same source as the KPI card (PAST_DUE post-reconcile).
  try {
    const res = await fetchArrearsSummary(db, locationId)
    if (res.success && res.data.memberCount > 0) {
      rows.push({
        key: 'arrears', chip: 'Arrears', tone: 'amber',
        text: `${res.data.memberCount} member${res.data.memberCount === 1 ? '' : 's'} — €${Math.round(res.data.totalCents / 100).toLocaleString('en-IE')} owed`,
        href: '/dashboard/churn-radar',
      })
    }
  } catch { /* omitted */ }

  // 4. Churn — latest snapshot count (cheap; the KPI card carries the
  // live radar number, this row is the pointer).
  try {
    const { data } = await db.from('churn_radar_snapshots')
      .select('high_risk, captured_at')
      .eq('location_id', locationId)
      .order('captured_at', { ascending: false }).limit(1)
    const hi = data?.[0]?.high_risk || 0
    if (hi > 0) {
      rows.push({
        key: 'churn', chip: 'Churn', tone: 'amber',
        text: `${hi} member${hi === 1 ? '' : 's'} at high risk`,
        href: '/dashboard/churn-radar',
      })
    }
  } catch { /* omitted */ }

  // 5. Uncontacted new leads older than 24h: still in new_lead, joined
  // >24h ago, no contacted/outreach action recorded.
  try {
    const cutoffIso = new Date(now.getTime() - DAY_MS).toISOString()
    const { data: leads } = await db.from('contacts')
      .select('id')
      .eq('location_id', locationId).eq('pipeline_stage_slug', 'new_lead')
      .lte('joined_at', cutoffIso)
      .limit(100)
    const ids = (leads || []).map(l => l.id)
    let uncontacted = ids.length
    if (ids.length) {
      // eslint-disable-next-line guardrails/no-uncapped-supabase-limit -- ids is capped at 100 leads above; contacting actions per contact are a tiny set, so 1000 captures every row
      const { data: actions } = await db.from('lead_radar_actions')
        .select('contact_id')
        .in('contact_id', ids)
        .in('action', ['contacted', 'outreach_sent'])
        .limit(1000)
      const touched = new Set((actions || []).map(a => a.contact_id))
      uncontacted = ids.filter(id => !touched.has(id)).length
    }
    if (uncontacted > 0) {
      rows.push({
        key: 'leads', chip: 'Leads', tone: 'teal',
        text: `${uncontacted} lead${uncontacted === 1 ? '' : 's'} uncontacted > 24h`,
        href: '/dashboard/lead-radar',
      })
    }
  } catch { /* omitted */ }

  return rows
}
