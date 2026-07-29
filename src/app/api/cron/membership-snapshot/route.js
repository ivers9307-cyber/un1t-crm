// Vercel cron — daily membership snapshot (DASH-MEMBERSHIP.1;
// daily since TREND-DAILY.1 — monthly gave the trend chart one point
// per month, i.e. two dots after two months).
//
// Runs daily at 02:00 UTC. For every active location it computes the
// current membership breakdown (monthly recurring vs class packs vs
// payg, plus active-recurring + dead-pack sub-metrics) and upserts one
// membership_snapshots row for the Dublin day. The business
// dashboard's trend chart reads from that table.
//
// Idempotent — re-running on the same day upserts the same
// (location_id, snapshot_date) row. Heartbeat expectation tightened to
// daily in mig 455.
//
// Auth: same fail-closed CRON_SECRET pattern as the other crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { writeMembershipSnapshot } from '@/lib/membership-snapshot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
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
    console.warn(`[cron][membership-snapshot] failed to list locations: ${locErr.message}`)
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
  }

  const results = []
  let firstError = null
  for (const loc of locations || []) {
    try {
      const snap = await writeMembershipSnapshot(db, loc.id)
      results.push({ location_id: loc.id, location_name: loc.name, ...snap })
    } catch (e) {
      if (!firstError) firstError = `[${loc.id}] ${e?.message || 'threw'}`
      results.push({ location_id: loc.id, location_name: loc.name, error: e?.message || 'threw' })
    }
  }

  await stampHeartbeat('membership-snapshot')

  return NextResponse.json({
    success: !firstError,
    locations_processed: results.length,
    first_error: firstError,
    snapshots: results,
  })
}
