// Vercel cron — every 15 minutes.
//
// UN1TSYNC.8 — pulls each connected un1t.online studio into the CRM. The API
// ignores `updated_since`, so every run is a full pull (runUn1tSync, Task 6);
// the 15-minute cadence is what keeps the mirror fresh for Hatch Street.
//
// Per-location flow:
//   1. Discovery goes through the membership seam: active locations whose
//      membership_source is 'un1t_online' and whose provider is configured.
//      A failed seam read is a 500 with NO heartbeat, never "no locations".
//   2. Locations run SEQUENTIALLY (one token, one rate budget each), within
//      a wall-clock budget (UN1THARD.4): once BUDGET_MS has passed, no further
//      location starts this invocation; the rest are counted as
//      `deferred_budget` and run on the next tick (every 15 min). A location
//      whose sync is already running (Sync now, mig 735) is `skipped_in_progress`,
//      not a failure.
//   3. ok → stamp the tenant heartbeat. (HATCHPIPE.2: the hourly reclassify of the
//      studio's board runs after step 4, deadline-raced; its result never
//      reaches the outcome or the heartbeats.) Not ok (auth, studio_mismatch, api,
//      truncated, db, not_connected) is COUNTED by reason, not fatal: the cron
//      is healthy, the location is not, and the connection row already carries
//      the readable last_error. A thrown exception from one location is counted
//      as failed too and the next location still runs (a runner never kills
//      other work).
//   4. Stamp cron_heartbeat with counts only. The outcome carries no token,
//      no exception text and no PII: numbers and reason codes.
//
// Auth: same CRON_SECRET pattern as the other Vercel crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { stampTenantHeartbeat } from '@/lib/tenant-heartbeat'
import { locationsWithSource } from '@/lib/membership/locations-for-source'
import { runUn1tSync } from '@/lib/un1t-online-sync'
import { maybeReclassifyAfterSync } from '@/lib/un1t-pipeline-cadence'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const CRON_NAME = 'un1t-online-sync'
// Stop STARTING locations after this long, leaving room under maxDuration for
// the one in flight (a run takes seconds today; the slowest seen was 14.5 s).
export const BUDGET_MS = 240_000
// The reclassify pass after a good sync: at most 60 s each, and never past 285 s
// into the invocation (maxDuration is 300).
const RECLASSIFY_CAP_MS = 60_000
const TOTAL_DEADLINE_MS = 285_000

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()

  const { eligible, skipped, error: locErr } = await locationsWithSource(db, 'un1t_online', { module: CRON_NAME })
  if (locErr) {
    logError(CRON_NAME, 'failed to list locations', { err: locErr })
    return NextResponse.json({ success: false, error: locErr.message || 'Could not list locations' }, { status: 500 })
  }

  const started = Date.now()
  let processed = 0
  let failed = 0
  let skippedInProgress = 0
  let deferredBudget = 0
  const failedByReason = {}
  const okLocationIds = []
  const countFailure = (reason) => {
    failed++
    failedByReason[reason] = (failedByReason[reason] || 0) + 1
  }

  for (const [i, loc] of eligible.entries()) {
    if (Date.now() - started > BUDGET_MS) {
      deferredBudget = eligible.length - i
      logWarn(CRON_NAME, 'time budget spent; deferring the remaining locations to the next tick', { deferred: deferredBudget })
      break
    }
    let result
    try {
      result = await runUn1tSync(db, loc.id)
    } catch (err) {
      // runUn1tSync reports expected failures as { ok: false }. A throw is a
      // bug or an infrastructure fault: count it, never log its text (a token
      // could ride in a message), and carry on to the next location.
      logError(CRON_NAME, 'location sync threw', { locationId: loc.id, errName: err?.name ?? null })
      countFailure('exception')
      continue
    }
    if (result?.ok) {
      processed++
      // SAAS4-O1 — only a location whose sync completed stamps its tenant row.
      await stampTenantHeartbeat(CRON_NAME, loc.id)
      okLocationIds.push(loc.id)
    } else if (result?.reason === 'in_progress') {
      // A Sync now (or another invocation) is running this studio right now.
      skippedInProgress++
    } else {
      const reason = result?.reason || 'unknown'
      logWarn(CRON_NAME, 'location sync did not complete', { locationId: loc.id, reason })
      countFailure(reason)
    }
  }

  const outcome = {
    locations_processed: processed,
    failed_locations: failed,
    failed_by_reason: failedByReason,
    skipped: (skipped || []).length,
    skipped_in_progress: skippedInProgress,
    deferred_budget: deferredBudget,
  }
  await stampHeartbeat(CRON_NAME, outcome)
  const payload = { success: true, ...outcome }

  // HATCHPIPE.2 — a good sync is followed by an hourly board pass. It runs only
  // AFTER the heartbeat and the payload are settled, each call in its own
  // try/catch and raced against a deadline, so a slow or hung pass can neither
  // change this run's outcome nor keep the heartbeat from stamping.
  for (const locationId of okLocationIds) {
    const left = Math.max(0, Math.min(RECLASSIFY_CAP_MS, TOTAL_DEADLINE_MS - (Date.now() - started)))
    let timer
    try {
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ran: false, reason: 'timeout' }), left)
      })
      const res = await Promise.race([maybeReclassifyAfterSync(db, locationId), timedOut])
      if (res?.reason === 'timeout') {
        logWarn(CRON_NAME, 'reclassify after sync timed out', { locationId })
      }
    } catch (err) {
      logError(CRON_NAME, 'reclassify after sync threw', { locationId, errName: err?.name ?? null })
    } finally {
      clearTimeout(timer)
    }
  }

  return NextResponse.json(payload)
}
