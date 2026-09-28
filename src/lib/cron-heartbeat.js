// Cron heartbeat helper.
//
// Each cron route calls stampHeartbeat(name) when a run succeeds, and so does
// each cron ARM that has a row of its own (an arm is a job riding another
// cron's schedule; which arms have rows, and when an arm's run is clean
// enough to stamp, is src/lib/cron-arm-health.js, or inline in
// src/app/api/cron/checklist-sweep/route.js for its two arms). public.cron_heartbeats
// (mig 053) holds one row per name, and the cron_health view (mig 053,
// security_invoker since mig 054) flags is_stale when last_ok_at falls
// outside expected_interval + grace. /api/cron/health-check reads that view
// and returns 503 when any row is stale; the external uptime monitor and
// Sentinel (its cron-health check turns the 503's `stale` list into one
// signal per name) both poll it. Only last_ok_at pages: last_outcome
// (mig 315) is for a person reading the row.
//
// Every name needs a row, seeded by a migration (mig 053 seeded the first
// three; since then, normally in the cron's or arm's own migration). The stamp is
// UPDATE-only, so a name with no row changes nothing and only logs "stamp
// matched 0 rows" (below). A new cron's row ships in that cron's migration
// (CLAUDE.md, "New cron"). An ARM's row is (re-)seeded RIGHT AFTER the deploy
// that stamps it, because an arm row seeded earlier goes stale after
// interval + grace and pages (cron-arm-health.js).
//
// stampHeartbeat() is intentionally best-effort: a failure to write the
// heartbeat must NEVER fail the cron itself. Worst case, a transient DB
// hiccup means one stamp is missed; the next tick covers it. We swallow
// errors loudly via the structured logger so Vercel runtime logs +
// Sentinel still capture them for debugging.

import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'

/**
 * Stamp last_ok_at = NOW() on the named heartbeat row. Best-effort —
 * never throws, never blocks the cron's response.
 *
 * @param {string} name — must match a row in public.cron_heartbeats
 *                        (seeded by that cron's or arm's own migration).
 * @param {object} [outcome] — optional JSON-serialisable summary of this run's
 *                        work, e.g. { processed: 5, skipped: 0, deadLettered: 1 }.
 *                        When provided, also writes last_outcome so ops can
 *                        distinguish "ran and idle" from "ran but broken".
 *                        When omitted, last_outcome is left unchanged
 *                        (the view never reads it).
 */
export async function stampHeartbeat(name, outcome) {
  if (!name || typeof name !== 'string') {
    logWarn('cron-heartbeat', 'invalid name', { name })
    return
  }

  try {
    const db = createServerClient()
    const patch = { last_ok_at: new Date().toISOString() }
    if (outcome !== undefined) patch.last_outcome = outcome
    const { data, error } = await db
      .from('cron_heartbeats')
      .update(patch)
      .eq('name', name)
      .select('name')

    if (error) {
      logWarn('cron-heartbeat', 'stamp failed', { name, err: error })
      return
    }

    // Update with no matching row is silent in Postgres — but for our
    // use case it means "this cron is running but isn't registered for
    // monitoring", which is exactly the bug Betterstack caught after
    // mig 119. Surface it loudly so the next time someone adds a cron
    // and forgets the seed migration, the logs scream.
    if (!data || data.length === 0) {
      logWarn('cron-heartbeat', 'stamp matched 0 rows — cron not seeded in cron_heartbeats', { name })
    }
  } catch (e) {
    logWarn('cron-heartbeat', 'stamp threw', { name, err: e })
  }
}
