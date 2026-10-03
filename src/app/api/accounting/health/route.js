// src/app/api/accounting/health/route.js
//
// RCOV.P2 — the Runs & health tab's data: recent recon runs, hunt
// mailbox health, the feature's cron heartbeats, and 7-day LLM spend.
// Service-role client; access enforced here.
//
// TENANTSCOPE.1 — every figure is the ACTIVE studio's. recon_hunts carries
// no location, so a hunt's studio is its bank line's
// (recon_bank_lines.location_id, mig 367), joined !inner. The hunt budget
// itself is ONE estate-wide weekly cap (hunt.js weeklySpendSoFar sums every
// tenant), so the payload says whether that shared cap is reached — one
// bit, never who spent it — and only a master also gets the estate total.
// The location-less `runs` rows are the weekly coverage report
// (recon/finalize.js): one estate-wide cycle, carrying a status and counts,
// never a tenant's lines or an error text.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import { HUNT_WEEKLY_BUDGET_USD } from '@/lib/recon/budget'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEARTBEATS = ['receipt-coverage-weekly', 'process-receipt-hunts']
const PAGE = 1000

// Mirrors weeklySpendSoFar in src/lib/recon/hunt.js (kept local so a
// display route never imports the hunt engine; comment there notes
// the loop is virtually always one round trip). With a locationId it sums
// that studio's hunts only; with none, the estate — the budget's own scope.
async function spend7dUsd(db, locationId = null) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  let sum = 0
  for (let start = 0; ; start += PAGE) {
    const base = db.from('recon_hunts')
    const scoped = locationId
      ? base
          .select('llm_spend_usd, recon_bank_lines!inner(location_id)')
          .eq('recon_bank_lines.location_id', locationId)
      : base.select('llm_spend_usd')
    const { data, error } = await scoped
      .gte('started_at', since)
      .order('id')
      .range(start, start + PAGE - 1)
    if (error) throw new Error(`health spend lookup failed: ${error.message}`)
    for (const r of data || []) sum += Number(r.llm_spend_usd) || 0
    if (!data || data.length < PAGE) break
  }
  return sum
}

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'accounting_hub')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const db = createServerClient()
  try {
    // Runs for this location + the location-less report rows.
    const { data: runRows, error: runErr } = await db
      .from('recon_runs')
      .select('id, trigger, status, started_at, finished_at, error, stats')
      .or(`location_id.eq.${locationId},location_id.is.null`)
      .order('started_at', { ascending: false })
      .limit(20)
    if (runErr) throw new Error(`health runs failed: ${runErr.message}`)
    const runs = (runRows || []).map((r) => ({
      id: r.id,
      trigger: r.trigger,
      status: r.status,
      started_at: r.started_at,
      finished_at: r.finished_at,
      error: r.error,
      accounts: Array.isArray(r.stats?.accounts) ? r.stats.accounts.length : null,
      anomalies: Array.isArray(r.stats?.anomalies) ? r.stats.anomalies.length : 0,
      forced: !!r.stats?.forced,
    }))

    const { data: mailboxes, error: mbErr } = await db
      .from('recon_mailboxes')
      .select('id, label, email, active, last_ok_at, last_error')
      .eq('location_id', locationId)
      .order('created_at')
    if (mbErr) throw new Error(`health mailboxes failed: ${mbErr.message}`)

    const { data: hbRows, error: hbErr } = await db
      .from('cron_heartbeats')
      .select('name, last_ok_at, expected_interval_seconds, grace_seconds, notes')
      .in('name', HEARTBEATS)
    if (hbErr) throw new Error(`health heartbeats failed: ${hbErr.message}`)
    const now = Date.now()
    const heartbeats = (hbRows || []).map((h) => ({
      ...h,
      stale:
        !h.last_ok_at ||
        now - new Date(h.last_ok_at).getTime() >
          (h.expected_interval_seconds + h.grace_seconds) * 1000,
    }))

    const [spendHere, spendEstate] = await Promise.all([
      spend7dUsd(db, locationId),
      spend7dUsd(db),
    ])

    return NextResponse.json({
      success: true,
      data: {
        runs,
        mailboxes: mailboxes || [],
        heartbeats,
        spend7dUsd: spendHere,
        budget: { weeklyUsd: HUNT_WEEKLY_BUDGET_USD, exhausted: spendEstate >= HUNT_WEEKLY_BUDGET_USD },
        ...(user.isMaster ? { spend7dUsdAll: spendEstate } : {}),
      },
    })
  } catch (e) {
    console.error('[accounting/health]', e)
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
