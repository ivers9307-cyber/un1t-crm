// LEAD-TREND.1 — weekly Lead Radar snapshot cron.
//
// Runs Monday 06:30 UTC. For every active location it computes the
// current Lead Radar summary and writes one lead_radar_snapshots
// row. The Lead Radar UI then compares the live summary against the
// most recent snapshot to show week-over-week deltas on its cards.
//
// Auth: same CRON_SECRET pattern as the other Vercel crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { loadFunnel } from '@/lib/lead-radar-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// loadFunnel pages the ~7,000-row non-member base per location.
// Single-tenant in practice; 120s leaves headroom.
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
    console.warn(`[cron][lead-radar-snapshot] failed to list locations: ${locErr.message}`)
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
  }

  const rows = []
  const perLocation = []
  for (const loc of locations || []) {
    try {
      const { summary } = await loadFunnel(db, loc.id)
      rows.push({
        location_id: loc.id,
        funnel_total: summary.funnelTotal || 0,
        attending: summary.funnel?.attending || 0,
        fresh: summary.funnel?.fresh || 0,
        cleanup_total: summary.cleanupTotal || 0,
      })
      perLocation.push({ location_id: loc.id, location_name: loc.name, ok: true })
    } catch (e) {
      // One bad location can't stall the rest of the sweep.
      perLocation.push({ location_id: loc.id, location_name: loc.name, ok: false, error: e.message })
    }
  }

  let snapshotsWritten = 0
  if (rows.length) {
    const { error: insErr } = await db.from('lead_radar_snapshots').insert(rows)
    if (insErr) {
      return NextResponse.json({ success: false, error: insErr.message }, { status: 500 })
    }
    snapshotsWritten = rows.length
  }

  await stampHeartbeat('lead-radar-snapshot').catch(() => {})

  return NextResponse.json({
    success: true,
    locations: perLocation.length,
    snapshots_written: snapshotsWritten,
    perLocation,
  })
}
