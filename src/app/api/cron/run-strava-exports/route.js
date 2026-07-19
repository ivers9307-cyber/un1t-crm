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

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { runExportWorker } from '@/lib/external-export'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const out = await runExportWorker(db, { batchSize: 20 })
  await stampHeartbeat('run-strava-exports').catch((err) =>
    logWarn('cron-strava-exports', 'heartbeat failed', { err }))
  return NextResponse.json(out)
}
