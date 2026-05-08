// Cron heartbeat helper.
//
// Each cron route calls stampHeartbeat(name) on success. The cron_health
// view (mig 053) flags is_stale=true when last_ok_at falls outside
// expected_interval + grace, and /api/cron/health-check returns 503 when
// any row is stale. An external monitor (UptimeRobot, Better Stack, etc.)
// pings the health-check endpoint every few minutes — one URL covers all
// crons.
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
 *                        (seeded via mig 053 for the three current crons).
 */
export async function stampHeartbeat(name) {
  if (!name || typeof name !== 'string') {
    logWarn('cron-heartbeat', 'invalid name', { name })
    return
  }

  try {
    const db = createServerClient()
    const { data, error } = await db
      .from('cron_heartbeats')
      .update({ last_ok_at: new Date().toISOString() })
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
