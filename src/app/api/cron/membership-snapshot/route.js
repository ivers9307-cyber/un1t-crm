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
import { READS_BY_SOURCE } from '@/lib/membership/reads'
import { membershipStateForPage } from '@/lib/membership/state-for-page'
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

  // UN1TREAD.5 — eligibility is by the location's source KEY, not by whether
  // its credentials are live: Glofox counts read STORED contacts.glofox_* and
  // un1t.online counts read the un1t_* tables, neither of which needs a
  // working connection, and the trend must not gap while a credential is
  // being fixed. So a location is snapshotted whenever the adapter registered
  // for its source implements membershipCounts (glofox, un1t_online), in any
  // state (configured, unconfigured, or a credential read that failed but
  // still names the source). 'none' and unregistered keys are skipped with a
  // counted skipped_no_source. Only a location whose source key itself could
  // not be read (source null) is a real unknown: skipped, logged, counted in
  // skipped_unknown, never snapshotted with zeros. (The four other Glofox
  // crons keep the #2072 capability skip: they read live Glofox data.)
  let skippedNoSource = 0
  let skippedUnknown = 0

  const results = []
  let firstError = null
  for (const loc of locations || []) {
    try {
      const s = await membershipStateForPage(db, loc.id)
      if (!s?.source) {
        skippedUnknown++
        logError('membership-snapshot', 'membership source unreadable; location skipped this tick', {
          locationId: loc.id, state: s?.state ?? null, readError: s?.readError ?? null,
        })
        continue
      }
      const reads = Object.hasOwn(READS_BY_SOURCE, s.source) ? READS_BY_SOURCE[s.source] : null
      if (typeof reads?.membershipCounts !== 'function') { skippedNoSource++; continue }
      const counts = await reads.membershipCounts(db, loc.id)
      const snap = await writeMembershipSnapshot(db, loc.id, { zone: zoneOfLocation(loc), counts })
      results.push({ location_id: loc.id, location_name: loc.name, ...snap })
    } catch (e) {
      if (!firstError) firstError = `[${loc.id}] ${e?.message || 'threw'}`
      results.push({ location_id: loc.id, location_name: loc.name, error: e?.message || 'threw' })
    }
  }

  // A tick that visited nobody because every location it could have worked
  // was unreadable must not read healthy: 500, no heartbeat. One unknown
  // among processed locations stays a skip.
  if (results.length === 0 && skippedUnknown > 0) {
    console.warn(`[cron][membership-snapshot] no location processed; ${skippedUnknown} had an unreadable membership source`)
    return NextResponse.json({ success: false, error: 'membership source unreadable for every eligible location', skipped_unknown: skippedUnknown }, { status: 500 })
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
