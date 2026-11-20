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
// Auth: CRON_SECRET, via defineCron (src/lib/define-cron.js).
//
// ROUTEWRAP.C9 — on defineCron with the same stamps as before: a failed
// locations read, or a tick where every eligible location's source was
// unreadable, answers 500 and stamps nothing; every other tick stamps
// 'membership-snapshot', including one where a location threw (ok: false +
// stamp: true, still answered 200). The response names a failed location by id
// with a fixed line, never the error text (that goes to the log).

import { defineCron } from '@/lib/define-cron'
import { writeMembershipSnapshot } from '@/lib/membership-snapshot'
import { READS_BY_SOURCE } from '@/lib/membership/reads'
import { membershipStateForPage } from '@/lib/membership/state-for-page'
import { logError, logWarn } from '@/lib/log'
import { zoneOfLocation } from '@/lib/location-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const MODULE = 'membership-snapshot'

export const GET = defineCron({ heartbeat: 'membership-snapshot' }, async ({ db }) => {
  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name, timezone')
    .eq('active', true)
  if (locErr) {
    logWarn(MODULE, 'failed to list locations; not stamping', { err: locErr })
    return { ok: false, status: 500, body: { error: 'could not list locations' } }
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
  let failed = 0
  for (const loc of locations || []) {
    try {
      const st = await membershipStateForPage(db, loc.id)
      if (!st?.source) {
        skippedUnknown++
        logError(MODULE, 'membership source unreadable; location skipped this tick', {
          locationId: loc.id, state: st?.state ?? null, readError: st?.readError ?? null,
        })
        continue
      }
      const reads = Object.hasOwn(READS_BY_SOURCE, st.source) ? READS_BY_SOURCE[st.source] : null
      if (typeof reads?.membershipCounts !== 'function') { skippedNoSource++; continue }
      const counts = await reads.membershipCounts(db, loc.id)
      const snap = await writeMembershipSnapshot(db, loc.id, { zone: zoneOfLocation(loc), counts })
      results.push({ location_id: loc.id, location_name: loc.name, ...snap })
    } catch (err) {
      // ROUTEWRAP.C9 — the error text stays in the log; the response says only
      // which location failed.
      failed++
      logError(MODULE, 'location snapshot failed', { locationId: loc.id, err })
      results.push({ location_id: loc.id, location_name: loc.name, error: 'snapshot failed' })
    }
  }

  // A tick that visited nobody because every location it could have worked
  // was unreadable must not read healthy: 500, no heartbeat. One unknown
  // among processed locations stays a skip.
  if (results.length === 0 && skippedUnknown > 0) {
    logWarn(MODULE, 'no location processed; every eligible membership source unreadable', { skippedUnknown })
    return {
      ok: false, status: 500,
      body: { error: 'membership source unreadable for every eligible location', skipped_unknown: skippedUnknown },
    }
  }

  // A location that threw is a failed run (success: false) whose stamp is
  // still recorded: the other locations snapshotted, as before.
  return {
    ok: failed === 0,
    stamp: true,
    status: 200,
    body: {
      locations_processed: results.length,
      locations_failed: failed,
      skipped_no_source: skippedNoSource,
      skipped_unknown: skippedUnknown,
      snapshots: results,
    },
  }
})
