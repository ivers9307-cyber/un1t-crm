// ATTR-3 — nightly attribution canary + Sunday weekly attribution report.
//
// Thin wrapper: decisions in src/lib/hr-attribution-health.js (pure), IO in
// src/lib/hr-attribution-sweep.js. Runs at 21:45 UTC — 22:45 Dublin in
// summer, 21:45 in winter, safely after the last class either way, so the
// canary judges a COMPLETE day (a mid-afternoon run would call a strap worn
// in the 18:15 class "unattributed" simply because it hadn't happened yet).
//
// ?dry=1 decides everything and sends nothing; ?weekly=1 forces the weekly
// section on a non-Sunday (manual probe after a fix).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runAttributionHealthSweep } from '@/lib/hr-attribution-sweep'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const dry = url.searchParams.get('dry') === '1'
  const forceWeekly = url.searchParams.get('weekly') === '1'

  const result = await runAttributionHealthSweep({ db: createServerClient(), dry, forceWeekly })

  // Heartbeat only on a clean, real run — a half-failed sweep should read as
  // stale rather than quietly healthy, and a dry run is a manual probe.
  if (result.ok && !dry) await stampHeartbeat('attribution-health')

  return NextResponse.json({ success: result.ok, ...result })
}
