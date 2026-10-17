// Vercel cron — daily membership snapshot (DASH-MEMBERSHIP.1;
// daily since TREND-DAILY.1 — monthly gave the trend chart one point
// per month, i.e. two dots after two months).
//
// Runs daily at 02:00 UTC. For every active location it computes the
// current membership breakdown (monthly recurring vs class packs vs
// payg, plus active-recurring + dead-pack sub-metrics) and upserts one
// membership_snapshots row for the location's LOCAL day (TZ.11a: its
// locations.timezone; for every zone the local date of a 02:00 UTC run is a
// complete-day boundary). The business
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
import { membershipReadsFor, supportsRead } from '@/lib/membership/reads'
import { logError } from '@/lib/log'
import { zoneOfLocation } from '@/lib/location-time'

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
    .select('id, name, timezone')
    .eq('active', true)
  if (locErr) {
    console.warn(`[cron][membership-snapshot] failed to list locations: ${locErr.message}`)
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
  }

  // UN1TREAD.5 — a location is snapshotted when its membership source
  // provides member counts through the read seam (Glofox, un1t.online); one
  // seam call per location decides. A source that does not (none, unconfigured)
  // is skipped with a counted skipped_no_source. A location whose source state
  // could not be read ('unknown') is skipped and logged too — never
  // snapshotted with zeros. NOTE: unlike the #2072 capability skip this does
  // not read the static provider table, so it sees configuration: a Glofox
  // location missing credentials is skipped rather than snapshotted from stale
  // contacts. (The four other Glofox crons keep the capability skip.)
  let skippedNoSource = 0
  let skippedUnknown = 0

  const results = []
  let firstError = null
  for (const loc of locations || []) {
    try {
      const r = await membershipReadsFor(db, loc.id)
      if (r.state === 'unknown') {
        skippedUnknown++
        logError('membership-snapshot', 'membership source state unknown; location skipped this tick', {
          locationId: loc.id, readError: r.error ?? null,
        })
        continue
      }
      if (!supportsRead(r, 'membershipCounts')) { skippedNoSource++; continue }
      const counts = await r.reads.membershipCounts(db, loc.id)
      const snap = await writeMembershipSnapshot(db, loc.id, { zone: zoneOfLocation(loc), counts })
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
    skipped_no_source: skippedNoSource,
    skipped_unknown: skippedUnknown,
    first_error: firstError,
    snapshots: results,
  })
}
