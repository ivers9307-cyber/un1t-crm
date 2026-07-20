// SAAS4-M2 — nightly usage rollup (02:40 UTC, after the day's sends
// and before the morning briefing).
//
// Re-aggregates BOTH yesterday and today (Dublin) on every run via the
// mig 421 SQL function — the upsert is idempotent recompute-in-full,
// so late-arriving events (a Mia turn at 23:59, a slow webhook) are
// folded in by the next tick and a missed run self-heals. Aggregation
// lives in SQL because usage_events can exceed the PostgREST 1k-row
// select cap and supabase-js cannot GROUP BY.
//
// The rollups feed the operator usage page and (later) Stripe overage
// lines. The HARD-cap checks read live month sums instead
// (org_ai_spend_month_cents / org_email_sends_month) so caps never
// drift behind the rollup.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { dublinTodayStr } from '@/lib/dublin-time'
import { capNoticeDecision, dublinMonthStartStr } from '@/lib/usage-caps'
import { sendOpsAlert } from '@/lib/ops-alerts'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function dublinYesterdayStr(todayStr) {
  const [y, m, d] = todayStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const today = dublinTodayStr()
  const days = [dublinYesterdayStr(today), today]

  for (const day of days) {
    try {
      const { error } = await db.rpc('rollup_usage_for_day', { p_day: day })
      if (error) {
        return NextResponse.json({ success: false, error: `${day}: ${error.message}` }, { status: 500 })
      }
    } catch (e) {
      return NextResponse.json({ success: false, error: `${day}: ${e?.message || e}` }, { status: 500 })
    }
  }

  // SAAS4-M3 — 80%-of-hard-cap notices, once per meter per Dublin
  // month. Best-effort: a notice failure never fails the rollup.
  let notices = 0
  try {
    notices = await sendCapNotices(db, today)
  } catch (e) {
    logWarn('usage-rollup', 'cap-notice pass threw', { err: e?.message || e })
  }

  await stampHeartbeat('usage-rollup', { days, notices })
  return NextResponse.json({ success: true, days, notices })
}

async function sendCapNotices(db, todayStr) {
  const month = todayStr.slice(0, 7)
  const monthStart = dublinMonthStartStr(todayStr)

  const { data: orgs } = await db
    .from('org_settings')
    .select('organization_id, ai_hard_cap_cents, email_hard_cap_sends, ai_cap_notice_month, email_cap_notice_month')
    .or('ai_hard_cap_cents.not.is.null,email_hard_cap_sends.not.is.null')
  if (!orgs || orgs.length === 0) return 0

  let sent = 0
  for (const org of orgs) {
    const { data: locs } = await db
      .from('locations')
      .select('id')
      .eq('organization_id', org.organization_id)
      .eq('active', true)
    const locationIds = (locs || []).map((l) => l.id)
    if (locationIds.length === 0) continue

    const checks = []
    if (org.ai_hard_cap_cents != null) {
      const { data: spend } = await db.rpc('org_ai_spend_month_cents', {
        p_org: org.organization_id, p_month_start: monthStart,
      })
      checks.push({
        column: 'ai_cap_notice_month',
        decision: capNoticeDecision({
          cap: Number(org.ai_hard_cap_cents), current: Number(spend) || 0,
          noticeMonth: org.ai_cap_notice_month, month,
        }),
        title: 'AI spend at 80% of the hard cap',
        body: `This month's AI spend is at 80%+ of the org hard cap (est. $${((Number(spend) || 0) / 100).toFixed(2)} of $${(Number(org.ai_hard_cap_cents) / 100).toFixed(2)}). At the cap, Mia pauses with a human handoff. Raise the cap in Settings → Usage if that's not intended.`,
      })
    }
    if (org.email_hard_cap_sends != null) {
      const { data: sends } = await db.rpc('org_email_sends_month', {
        p_org: org.organization_id, p_month_start: monthStart,
      })
      checks.push({
        column: 'email_cap_notice_month',
        decision: capNoticeDecision({
          cap: Number(org.email_hard_cap_sends), current: Number(sends) || 0,
          noticeMonth: org.email_cap_notice_month, month,
        }),
        title: 'Email volume at 80% of the hard cap',
        body: `This month's email sends are at 80%+ of the org hard cap (${(Number(sends) || 0).toLocaleString()} of ${Number(org.email_hard_cap_sends).toLocaleString()}). At the cap, new campaigns are refused. Raise the cap in Settings → Usage if that's not intended.`,
      })
    }

    for (const check of checks) {
      if (check.decision !== 'send') continue
      // SAAS4-O2 — routed per tenant: emails the org's configured
      // ops_alert_emails; falls back to the master push when none are
      // set. One alert per org per meter per month (not per location).
      await sendOpsAlert({
        organizationId: org.organization_id,
        locationId: locationIds[0],
        subject: check.title,
        htmlBody: `<p>${check.body}</p>`,
        pushBody: check.body,
      })
      await db
        .from('org_settings')
        .update({ [check.column]: month })
        .eq('organization_id', org.organization_id)
      sent++
    }
  }
  return sent
}
