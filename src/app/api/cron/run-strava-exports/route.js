// Vercel cron — every 2 minutes.
// SWEEPER for the external_export_jobs queue (QSTASH.9): fresh jobs
// are usually push-delivered via /api/webhooks/qstash/strava-exports
// within seconds of the enqueue; this cron remains the delivery
// guarantee — it drains rows QStash missed, owns every RETRY on the
// queue's backoff schedule (the push worker deliberately 200s on
// failure), and is the ONLY consumer that recovers 'processing' rows
// a crashed invocation left behind (its batch select includes them).
// Strava is the only implementer for now; the worker route is named
// after it for clarity, but other providers (Garmin, etc) flow
// through the same queue once their client is built.
//
// defineCron owns the CRON_SECRET check, the error boundary and the heartbeat.
// A run stamps 'run-strava-exports' unless the queue read failed, which
// answers 500 with a fixed line and no stamp (the detail is logged).
// Per-job failures are counts, never a failed run.

import { defineCron } from '@/lib/define-cron'
import { runExportWorker } from '@/lib/external-export'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request) { return GET(request) }

export const GET = defineCron({ heartbeat: 'run-strava-exports' }, async ({ db }) => {
  const out = await runExportWorker(db, { batchSize: 20 })
  if (out.ok === false) return { ok: false, body: { error: 'Could not read the export queue' } }
  return { body: out }
})
