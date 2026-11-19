// SONOS.10 — Vercel cron, every minute. Applies Sonos schedule windows
// exactly once each (volume + favourite on open, pause on close).
// runSonosReconcile is the tested body; this route is a thin
// defineCron wrapper, same skeleton as class-climate.

import { defineCron } from '@/lib/define-cron'
import { runSonosReconcile } from '@/lib/sonos/reconcile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = defineCron({ heartbeat: 'sonos-reconcile' }, async ({ db }) => {
  const out = await runSonosReconcile(db)
  // `out.ok !== false`, not `out.ok === true`: the two `skipped` results carry
  // no `ok` key and a dormant deploy must not page. ok: false is a whole-run
  // read failure, so it does not stamp and a sustained outage goes stale.
  return { ok: out.ok !== false, status: 200, body: out }
})
