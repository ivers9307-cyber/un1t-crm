// Vercel cron — every 2 minutes.
// Drains the external_export_jobs queue. Strava is the only
// implementer for now; the worker route is named after it for
// clarity, but other providers (Garmin, etc) flow through the
// same queue once their client is built.

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
