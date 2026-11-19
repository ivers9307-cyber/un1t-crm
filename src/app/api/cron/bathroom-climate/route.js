// BATHROOM-CLIMATE.1 — Vercel cron, every 5 min. Turns the configured
// bathroom AC on for any class whose post-start window (start + delay)
// is open, for every location with the bathroom_climate automation
// enabled. The OFF is handled by the existing ac-auto-off cron (we write
// a session with a schedule-anchored auto_off_at). Idempotent via
// automation_fire_log.
//
// Auth: CRON_SECRET.

import { runBathroomClimate } from '@/lib/bathroom-climate-runner'
import { defineCron } from '@/lib/define-cron'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = defineCron({ heartbeat: 'bathroom-climate' }, async ({ db }) => {
  const out = await runBathroomClimate(db, {})
  // CRONWRAP.2 — ok: false is a whole-run read failure. It used to stamp
  // anyway, so a sustained outage never went stale (class-climate's fault).
  return { ok: out.ok !== false, status: 200, body: out }
})
