// SAAS4-M2 — nightly usage rollup (02:40 UTC, after the day's sends
// and before the morning briefing).
//
// Re-aggregates BOTH yesterday and today (Dublin) on every run via the
// mig 415 SQL function — the upsert is idempotent recompute-in-full,
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

  await stampHeartbeat('usage-rollup', { days })
  return NextResponse.json({ success: true, days })
}
