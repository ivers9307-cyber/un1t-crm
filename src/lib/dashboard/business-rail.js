// src/lib/dashboard/business-rail.js
//
// DASH-REBUILD — assembles the Business dashboard "Needs you" rail.
// Fixed category order: approvals, failed, arrears, churn, leads.
// Categories with zero items are omitted. Web-only (imports the
// approvals registry + radar snapshots), so it lives in src/lib, not
// shared/. Every row: { key, chip, tone, text, href }.
// tone ∈ 'purple' | 'red' | 'amber' | 'teal' — mapped to chip classes
// in the component, not here.
//
// DASH-REBUILD.6c — the five categories run in parallel: each is an
// async helper that returns a row or null (its own try/catch keeps
// failure isolation per category), gathered via Promise.allSettled
// (belt-and-braces) with order fixed structurally by the array literal.

import { loadRecentlyContacted } from '@/lib/contact-log'
import { getPendingApprovalsCount } from '@/lib/approvals/registry'
import { radarReadsFor } from '@/lib/membership/reads/index'
import { membershipReadsFor } from '@/lib/membership/reads'
import { providesCapability } from '@/lib/membership/state-for-page'
import { cachedChurnRadar, highRiskOf, arrearsOf } from '@/lib/dashboard/churn-count'
import { totalLabel } from '@/lib/radar-copy'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

// 1. Pending approvals — registry total across visible providers.
async function approvalsRow(db, user) {
  try {
    const count = await getPendingApprovalsCount(db, user)
    if (count > 0) {
      return {
        key: 'approvals', chip: 'Approval', tone: 'purple',
        text: `${count} pending approval${count === 1 ? '' : 's'}`,
        href: '/approvals',
      }
    }
  } catch { /* row omitted on failure */ }
  return null
}

// 2. Failed agent executions, last 7 days. No dismiss in v1 — rows
// age out of the window (spec).
async function failedRow(db, locationId, now) {
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
      return {
        key: 'failed', chip: 'Failed', tone: 'red',
        text: `Glofox action failed for ${who}${more}`,
        href,
      }
    }
  } catch { /* omitted */ }
  return null
}

// 3. Arrears. ARREARSONE.1 — the KPI card's number (overdue memberships minus
// the dismissed, the radar's Overdue tab), through the shared radar cache so
// the page scans once. Only where the studio's source supplies memberships;
// a failed or missing radar omits the row.
async function arrearsRow(db, locationId) {
  try {
    const m = await membershipReadsFor(db, locationId)
    if (!m?.reads || !providesCapability(m, 'memberships')) return null
    const a = arrearsOf(await cachedChurnRadar(db, locationId))
    if (a && a.memberCount > 0) {
      const n = a.memberCount
      return {
        key: 'arrears', chip: 'Arrears', tone: 'amber',
        text: `${n} member${n === 1 ? ' owes' : 's owe'} ${totalLabel(a.totalCents, { estimated: a.estimated })}`,
        href: '/dashboard/churn-radar',
      }
    }
  } catch { /* omitted */ }
  return null
}

// 4. Churn. CHURNONE.1 — the LIVE high-risk count, the number the KPI card
// shows (it used to read last Monday's snapshot, so the same page gave two
// answers). Through the shared radar cache, so the page scans once. Only
// where the studio's source supplies memberships, as the card's gate.
async function churnRow(db, locationId) {
  try {
    const m = await membershipReadsFor(db, locationId)
    if (!m?.reads || !providesCapability(m, 'memberships')) return null
    const hi = highRiskOf(await cachedChurnRadar(db, locationId))
    if (hi > 0) {
      return {
        key: 'churn', chip: 'Churn', tone: 'amber',
        text: `${hi} member${hi === 1 ? '' : 's'} at high risk`,
        href: '/dashboard/churn-radar',
      }
    }
  } catch { /* omitted */ }
  return null
}

// 5. Uncontacted new leads older than 24h: still in new_lead, joined
// >24h ago, no contacted/outreach action recorded.
async function leadsRow(db, locationId, now) {
  try {
    const cutoffIso = new Date(now.getTime() - DAY_MS).toISOString()
    // UN1TRADAR.3 — contacts.pipeline_stage_slug follows the PRIMARY board
    // (mig 595). Where that is not the acquisition board (Hatch: the manual
    // waitlist), count the acquisition board's own deals instead, but only
    // once the studio's provider supplies memberships (UN1TRADAR.4); before
    // the flip a manual-primary studio keeps main's contacts count.
    // CONTACTLOG.2 — "contacted" is the board's rule (loadRecentlyContacted:
    // a call, WhatsApp or email logged here lately), and the row opens the
    // board's "Not contacted" view; the Lead Radar it used to open is gone.
    // An acquisition-primary studio (Stillorgan) never reaches the check.
    const { data: boards, error: boardErr } = await db.from('pipelines')
      .select('id, key, is_primary, enabled')
      .eq('location_id', locationId)
    const primary = boardErr ? null : (boards || []).find((p) => p.is_primary)
    if (primary && primary.key !== 'acquisition' && await providesMembershipsAt(db, locationId)) {
      const acq = (boards || []).find((p) => p.key === 'acquisition' && p.enabled)
      if (!acq) return null
      return leadsRowRender(await uncontactedAcquisitionLeads(db, locationId, acq.id, cutoffIso, now))
    }
    const { data: leads } = await db.from('contacts')
      .select('id')
      .eq('location_id', locationId).eq('pipeline_stage_slug', 'new_lead')
      .lte('joined_at', cutoffIso)
      .limit(100)
    const ids = (leads || []).map(l => l.id)
    return leadsRowRender(await uncontactedOf(db, locationId, ids, now))
  } catch { /* omitted */ }
  return null
}

function leadsRowRender(uncontacted) {
  if (!(uncontacted > 0)) return null
  return {
    key: 'leads', chip: 'Leads', tone: 'teal',
    text: `${uncontacted} lead${uncontacted === 1 ? '' : 's'} uncontacted > 24h`,
    href: '/pipeline?nocontact=1',
  }
}

// The provider's static memberships capability (radarReadsFor, as arrearsRow
// reads it). An unreadable source answers false: the caller then takes main's
// contacts path, which is what this studio showed before UN1TRADAR.3.
async function providesMembershipsAt(db, locationId) {
  try {
    return (await radarReadsFor(db, locationId)).providesMemberships === true
  } catch {
    return false
  }
}

// Open deals at the acquisition board's new_lead stage created over 24h ago
// (capped at 100, as the contacts query is), minus the ones contacted at THIS
// studio lately (uncontactedOf). A failed read throws, so the row is omitted (as every rail
// row is on failure) rather than over-counting uncontacted leads.
async function uncontactedAcquisitionLeads(db, locationId, pipelineId, cutoffIso, now) {
  const { data: stages, error: stageErr } = await db.from('pipeline_stages')
    .select('id')
    .eq('location_id', locationId)
    .eq('pipeline_id', pipelineId)
    .eq('slug', 'new_lead')
  if (stageErr) throw stageErr
  const stageIds = (stages || []).map((st) => st.id)
  if (stageIds.length === 0) return 0
  const { data: deals, error: dealErr } = await db.from('deals')
    .select('contact_id')
    .eq('location_id', locationId)
    .eq('pipeline_id', pipelineId)
    .eq('status', 'open')
    .in('stage_id', stageIds)
    .lt('created_at', cutoffIso)
    .order('created_at', { ascending: true })
    .limit(100)
  if (dealErr) throw dealErr
  const ids = [...new Set((deals || []).map((d) => d.contact_id).filter(Boolean))]
  return uncontactedOf(db, locationId, ids, now)
}

// CONTACTLOG.2 — of `ids`, how many have no contact logged at the studio in
// CONTACT_WINDOW_DAYS. A failed read throws, so the row is omitted rather than
// over-counting uncontacted leads.
async function uncontactedOf(db, locationId, ids, now) {
  if (ids.length === 0) return 0
  const res = await loadRecentlyContacted(db, { locationId, contactIds: ids, nowMs: now.getTime() })
  if (!res.ok) throw new Error('contact log read failed')
  return ids.filter((id) => !res.contacted.has(id)).length
}

export async function buildNeedsYouRail(db, user, locationId, now = new Date()) {
  const settled = await Promise.allSettled([
    approvalsRow(db, user),
    failedRow(db, locationId, now),
    arrearsRow(db, locationId),
    churnRow(db, locationId),
    leadsRow(db, locationId, now),
  ])
  const rows = []
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) rows.push(r.value)
  }
  return rows
}
