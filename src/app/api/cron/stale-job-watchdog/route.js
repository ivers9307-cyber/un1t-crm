// STALEWATCH.1 — every 15 min: the in-CRM watchdog for background jobs
// (src/lib/stale-job-watchdog.js). Alerts the masters once per job that newly
// goes stale, clears the alert when it recovers, and sends one daily digest of
// everything still stale. Stamps its own heartbeat (mig 844) only when it
// could read cron_health; a delivery failure is logged and retried next tick,
// never a reason to look healthy-but-silent.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runStaleJobWatchdog, WATCHDOG_NAME } from '@/lib/stale-job-watchdog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request) {
  const auth = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const result = await runStaleJobWatchdog(createServerClient())
  if (!result.ok) {
    return NextResponse.json({ success: false, error: 'cron_health unreadable' }, { status: 500 })
  }
  await stampHeartbeat(WATCHDOG_NAME, {
    newly_stale: result.newlyStale.length, alerted: result.alerted, recovered: result.recovered.length,
    digest: result.digest, stale: result.stale,
  })
  return NextResponse.json({ success: true, data: result })
}
