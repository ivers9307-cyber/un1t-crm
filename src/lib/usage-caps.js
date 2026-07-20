// SAAS4-M2 — optional per-org hard caps (SaaS machinery plan §3).
//
// Richard's settled three-band model (2026-07-19): the plan allowance
// is a SOFT band — exceeding it accrues per-unit overage, nothing
// stops. Only an operator-set HARD cap interrupts service:
//   - ai_hard_cap_cents  → Mia pauses for new inbound (soft-handoff
//     with operator notice; the staff assistant is exempt).
//   - email_hard_cap_sends → new campaign starts are refused.
// Both live on org_settings and default NULL = no cap, so shipping
// this changes nothing until a cap is set. Plan allowances/overage
// pricing layer on top in the billing build (B1).
//
// Spend is computed LIVE from usage_events via SQL functions (mig 421)
// — the daily rollups feed the usage page, not the cap check, so there
// is no rollup-lag drift. Month boundaries are Dublin calendar months.
//
// Both checks FAIL OPEN: a metering-infrastructure error must never
// silence Mia or block a campaign.

import { createServerClient } from '@/lib/supabase'
import { dublinTodayStr } from '@/lib/dublin-time'

/** First day of the Dublin month containing `todayStr` (default: today). */
export function dublinMonthStartStr(todayStr = dublinTodayStr()) {
  return `${todayStr.slice(0, 7)}-01`
}

/**
 * SAAS4-M3 — should the 80%-of-hard-cap notice go out?
 * One notice per meter per Dublin month; nothing without a cap.
 *
 * @param {{ cap: number|null, current: number, noticeMonth: string|null, month: string }} p
 *   month/noticeMonth are 'YYYY-MM' strings.
 * @returns {'send'|'skip'}
 */
export function capNoticeDecision({ cap, current, noticeMonth, month }) {
  if (!cap || cap <= 0) return 'skip'
  if (noticeMonth === month) return 'skip'
  return current >= cap * 0.8 ? 'send' : 'skip'
}

async function resolveOrgId(client, { organizationId, locationId }) {
  if (organizationId) return organizationId
  if (!locationId) return null
  const { data } = await client
    .from('locations')
    .select('organization_id')
    .eq('id', locationId)
    .maybeSingle()
  return data?.organization_id || null
}

async function readOrgCaps(client, orgId) {
  const { data } = await client
    .from('org_settings')
    .select('ai_hard_cap_cents, email_hard_cap_sends')
    .eq('organization_id', orgId)
    .maybeSingle()
  return data || {}
}

/**
 * Is the org at its hard AI-spend cap for the current Dublin month?
 * Spend excludes the staff assistant (source 'assistant_chat') per the
 * settled decision — metered, not counted.
 *
 * @returns {Promise<{capped: boolean, capCents?: number, spendCents?: number, organizationId?: string}>}
 */
export async function getAiCapStatus({ organizationId, locationId }, { db } = {}) {
  try {
    const client = db || createServerClient()
    const orgId = await resolveOrgId(client, { organizationId, locationId })
    if (!orgId) return { capped: false }

    const caps = await readOrgCaps(client, orgId)
    const capCents = caps.ai_hard_cap_cents
    if (capCents == null) return { capped: false, organizationId: orgId }

    const { data: spend, error } = await client.rpc('org_ai_spend_month_cents', {
      p_org: orgId,
      p_month_start: dublinMonthStartStr(),
    })
    if (error) return { capped: false, organizationId: orgId }

    const spendCents = Number(spend) || 0
    return {
      capped: spendCents >= Number(capCents),
      capCents: Number(capCents),
      spendCents,
      organizationId: orgId,
    }
  } catch {
    return { capped: false }
  }
}

/**
 * Is the org at its hard email-send cap for the current Dublin month?
 * Counts actually-sent email_sends rows across the org's locations.
 *
 * @returns {Promise<{capped: boolean, capSends?: number, monthSends?: number, organizationId?: string}>}
 */
export async function getEmailCapStatus({ organizationId, locationId }, { db } = {}) {
  try {
    const client = db || createServerClient()
    const orgId = await resolveOrgId(client, { organizationId, locationId })
    if (!orgId) return { capped: false }

    const caps = await readOrgCaps(client, orgId)
    const capSends = caps.email_hard_cap_sends
    if (capSends == null) return { capped: false, organizationId: orgId }

    const { data: sends, error } = await client.rpc('org_email_sends_month', {
      p_org: orgId,
      p_month_start: dublinMonthStartStr(),
    })
    if (error) return { capped: false, organizationId: orgId }

    const monthSends = Number(sends) || 0
    return {
      capped: monthSends >= Number(capSends),
      capSends: Number(capSends),
      monthSends,
      organizationId: orgId,
    }
  } catch {
    return { capped: false }
  }
}
