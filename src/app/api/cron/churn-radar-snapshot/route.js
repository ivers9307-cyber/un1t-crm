// RADAR-TREND.1 — weekly churn-radar snapshot cron.
//
// Runs Monday 06:00 UTC. For every active location it computes the
// current churn radar summary and writes one churn_radar_snapshots
// row. The radar UI then compares the live summary against the most
// recent snapshot to show week-over-week deltas on the summary cards.
//
// Auth: same CRON_SECRET pattern as the other Vercel crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { loadRadar } from '@/lib/churn-radar-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// loadRadar pages the member base + action log per location. Single-
// tenant in practice; 120s leaves headroom if more locations are added.
export const maxDuration = 120

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()

  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name')
    .eq('active', true)
  if (locErr) {
    console.warn(`[cron][churn-radar-snapshot] failed to list locations: ${locErr.message}`)
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
  }

  const rows = []
  const perLocation = []
  for (const loc of locations || []) {
    try {
      const { summary } = await loadRadar(db, loc.id)
      rows.push({
        location_id: loc.id,
        active_base: summary.activeBase || 0,
        at_risk: summary.atRisk || 0,
        high_risk: summary.highRisk || 0,
        overdue: summary.overdue || 0,
        paused: summary.paused || 0,
        quarantine: summary.quarantine || 0,
        revenue_at_risk_cents: summary.revenueAtRiskCents || 0,
        overdue_value_cents: summary.overdueValueCents || 0,
      })
      perLocation.push({ location_id: loc.id, location_name: loc.name, ok: true })
    } catch (e) {
      // One bad location can't stall the rest of the sweep.
      perLocation.push({ location_id: loc.id, location_name: loc.name, ok: false, error: e.message })
    }
  }

  let snapshotsWritten = 0
  if (rows.length) {
    const { error: insErr } = await db.from('churn_radar_snapshots').insert(rows)
    if (insErr) {
      return NextResponse.json({ success: false, error: insErr.message }, { status: 500 })
    }
    snapshotsWritten = rows.length
  }

  await stampHeartbeat('churn-radar-snapshot').catch(() => {})

  return NextResponse.json({
    success: true,
    locations: perLocation.length,
    snapshots_written: snapshotsWritten,
    perLocation,
  })
}
