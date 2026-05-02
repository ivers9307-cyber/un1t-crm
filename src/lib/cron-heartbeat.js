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
// errors loudly via console.warn so Vercel runtime logs still capture
// them for debugging.

import { createServerClient } from '@/lib/supabase'

/**
 * Stamp last_ok_at = NOW() on the named heartbeat row. Best-effort —
 * never throws, never blocks the cron's response.
 *
 * @param {string} name — must match a row in public.cron_heartbeats
 *                        (seeded via mig 053 for the three current crons).
 */
export async function stampHeartbeat(name) {
  if (!name || typeof name !== 'string') {
    console.warn(`[cron-heartbeat] invalid name: ${JSON.stringify(name)}`)
    return
  }

  try {
    const db = createServerClient()
    const { error } = await db
      .from('cron_heartbeats')
      .update({ last_ok_at: new Date().toISOString() })
      .eq('name', name)

    if (error) {
      console.warn(`[cron-heartbeat] stamp failed for ${name}: ${error.message}`)
    }
  } catch (e) {
    console.warn(`[cron-heartbeat] stamp threw for ${name}: ${e?.message || String(e)}`)
  }
}
