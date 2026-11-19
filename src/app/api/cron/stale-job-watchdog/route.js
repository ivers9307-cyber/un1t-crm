// STALEWATCH.1 — every 15 min: the in-CRM watchdog for background jobs
// (src/lib/stale-job-watchdog.js). Alerts the masters once per job that newly
// goes stale, clears the alert when it recovers, and sends one daily digest of
// everything still stale. Stamps its own heartbeat (mig 844) only when it
// could read cron_health; a delivery failure is logged and retried next tick,
// never a reason to look healthy-but-silent.

import { defineCron } from '@/lib/define-cron'
import { runStaleJobWatchdog, WATCHDOG_NAME } from '@/lib/stale-job-watchdog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = defineCron({ heartbeat: WATCHDOG_NAME }, async ({ db }) => {
  const result = await runStaleJobWatchdog(db)
  if (!result.ok) return { ok: false, body: { error: 'cron_health unreadable' } }
  return {
    body: { data: result },
    outcome: {
      newly_stale: result.newlyStale.length, alerted: result.alerted, recovered: result.recovered.length,
      digest: result.digest, stale: result.stale,
    },
  }
})
