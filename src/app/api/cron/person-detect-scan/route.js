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
// failure is what actually surfaces that to an operator.
//
// Auth: same CRON_SECRET Bearer pattern as every other Vercel cron.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logInfo, logError } from '@/lib/log'
import { runDetection } from '@/lib/person-detect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Detection paginates contacts/suggestions/groups per location (up to the
// 20k hard limit each) and can call createGroup/addToGroup per
// high-confidence pair — give it the same 5-min ceiling as the other
// multi-location scan crons (pipeline-classify, wallet-overage-draws).
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()

  // Every active location — mirrors pipeline-classify / glofox-data-quality.
  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name')
    .eq('active', true)
  if (locErr) {
    logError('cron.person-detect-scan', 'failed to list active locations', { err: locErr })
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
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
        error: e?.message || String(e),
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

  // Withhold the heartbeat on ANY location failure — see header note.
  if (failed === 0) {
    await stampHeartbeat('person-detect-scan', outcome)
  }

  return NextResponse.json({ success: true, data: outcome })
}
