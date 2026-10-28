// USAGE.1 — every 15 minutes: rebuild the last three days' app usage
// totals (app_usage_daily) from the raw sessions and visits, and enforce
// retention (raw 90 days, daily 400). The work and its rules live in
// src/lib/app-usage/rollup.js.
//
// Idempotent: each run re-derives whole days, so a missed or doubled tick
// converges. The heartbeat (mig 779, 900 s + 1200 s grace) is stamped only
// when the whole run succeeded; a failed read or write answers 500 and
// leaves the previous totals in place.
//
// CRON_SECRET bearer auth, same as every other cron.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { getLocationZones } from '@/lib/location-time'
import { runUsageRollup } from '@/lib/app-usage/rollup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const HEARTBEAT_NAME = 'app-usage-rollup'

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const nowMs = Date.now()
  try {
    const result = await runUsageRollup(db, {
      nowMs,
      getZones: (ids) => getLocationZones(db, ids, { nowMs }),
    })
    await stampHeartbeat(HEARTBEAT_NAME, result)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    logError('cron-app-usage-rollup', 'rollup failed', { message: err?.message || String(err) })
    return NextResponse.json({ ok: false, error: 'Rollup failed' }, { status: 500 })
  }
}
