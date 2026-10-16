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
//   2. Locations run SEQUENTIALLY (one token, one rate budget each).
//   3. ok → stamp the tenant heartbeat. Not ok (auth, studio_mismatch, api,
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
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const CRON_NAME = 'un1t-online-sync'

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

  let processed = 0
  let failed = 0
  const failedByReason = {}
  const countFailure = (reason) => {
    failed++
    failedByReason[reason] = (failedByReason[reason] || 0) + 1
  }

  for (const loc of eligible) {
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
  }
  await stampHeartbeat(CRON_NAME, outcome)

  return NextResponse.json({ success: true, ...outcome })
}
