// GET /api/cron/person-detect-scan — daily duplicate-detection sweep
// (PERSON-ACCT.10).
//
// Why: one person routinely has 2-3 `contacts` rows (ClassPass mints a new
// shadow account per re-book). PR1/PR2 taught the agent to read across a
// person's whole person_group and elect one account for writes, but that
// coverage is bounded by whether the duplicates have actually been
// GROUPED — and until this cron, grouping only happened when a human
// clicked "run detection" in the UI (POST /api/contacts/duplicates/detect).
// A new ClassPass shadow account could sit un-grouped indefinitely.
//
// This cron closes that gap: once daily, for every ACTIVE location, it
// calls runDetection(db, { commit: true }) — the exact same function the
// manual UI action calls. commit:true only ever auto-links the
// HIGH-CONFIDENCE pairs (person-detect.js's own rule, unchanged here);
// medium/low-confidence candidates are still upserted into
// person_link_suggestions for a human to review, exactly as today. This
// route adds NO new matching logic — it is scheduling, not detection.
//
// Per-location isolation: one location's runDetection throwing (a bad
// pair, a transient DB error inside the paginated loaders, etc.) must
// never stop the sweep from reaching the other locations, so each call is
// wrapped in its own try/catch and failures are collected, not thrown.
//
// Heartbeat posture: stamped ONLY when every location succeeded (matches
// wallet-overage-draws: `if (stats.failed === 0) await stampHeartbeat(...)`)
// — NOT merely "not every location failed". A run where 2 of 3 locations
// linked fine but 1 silently dropped its linking should not read as
// healthy on the cron-health dashboard; withholding the stamp on ANY
// failure is what actually surfaces that to an operator. A run where EVERY
// location failed is a failed run: 500. A location's error text stays in the
// log; the response names the location with a fixed 'detection failed'.
//
// Auth, the error boundary and the stamp: defineCron.

import { defineCron } from '@/lib/define-cron'
import { logInfo, logError } from '@/lib/log'
import { runDetection } from '@/lib/person-detect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Detection paginates contacts/suggestions/groups per location (up to the
// 20k hard limit each) and can call createGroup/addToGroup per
// high-confidence pair — give it the same 5-min ceiling as the other
// multi-location scan crons (pipeline-classify, wallet-overage-draws).
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'person-detect-scan' }, async ({ db }) => {
  // Every active location — mirrors pipeline-classify / glofox-data-quality.
  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name')
    .eq('active', true)
  if (locErr) {
    logError('cron.person-detect-scan', 'failed to list active locations', { err: locErr })
    return { ok: false, body: { error: 'Could not read locations' } }
  }

  const perLocation = []
  let failed = 0

  for (const loc of locations || []) {
    try {
      // commit:true is the auto-link path already implemented by
      // runDetection: high-confidence pairs get linked, medium/low stay
      // queued in person_link_suggestions for manual review. actorId is
      // null — this is a scheduled system run, not a staff decision.
      const result = await runDetection(db, { locationId: loc.id, commit: true, actorId: null })
      perLocation.push({
        location_id: loc.id,
        location_name: loc.name,
        counts: result.counts,
        autoLinked: result.autoLinked,
        skipped: result.skipped,
        failures: result.failures,
        totalCandidates: result.totalCandidates,
        superseded: result.superseded,
      })
    } catch (e) {
      failed += 1
      logError('cron.person-detect-scan', 'location detection scan failed', {
        locationId: loc.id,
        err: e,
      })
      perLocation.push({
        location_id: loc.id,
        location_name: loc.name,
        error: 'detection failed',
      })
    }
  }

  const outcome = {
    locations: perLocation.length,
    failed,
    perLocation,
  }

  logInfo('cron.person-detect-scan', 'run complete', {
    locations: outcome.locations,
    failed: outcome.failed,
  })

  if (failed > 0 && failed === perLocation.length) {
    return { ok: false, body: { error: 'Detection failed at every location', data: outcome } }
  }
  // Withhold the heartbeat on ANY location failure — see header note.
  return { body: { data: outcome }, outcome, stamp: failed === 0 }
})
