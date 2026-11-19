// CLASS-CLIMATE.1 — Vercel cron, every 5 min. Turns the configured AC on
// for any class whose pre-class window is open, for every location with
// the class_climate automation enabled. The OFF is handled by the
// existing ac-auto-off cron (we write a session with a class-aligned
// auto_off_at). Idempotent via automation_fire_log.

import { defineCron } from '@/lib/define-cron'
import { runClassClimate } from '@/lib/class-climate-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = defineCron({ heartbeat: 'class-climate' }, async ({ db }) => {
  const out = await runClassClimate(db, {})
  // ok: false is a whole-run read failure, so it does not stamp and a
  // sustained outage goes stale.
  return { ok: out.ok !== false, status: 200, body: out }
})
