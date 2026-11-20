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
// defineCron owns the CRON_SECRET check and the heartbeat stamp.

import { defineCron } from '@/lib/define-cron'
import { logError } from '@/lib/log'
import { getLocationZones } from '@/lib/location-time'
import { runUsageRollup } from '@/lib/app-usage/rollup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const HEARTBEAT_NAME = 'app-usage-rollup'

export async function POST(request) { return GET(request) }

export const GET = defineCron({ heartbeat: HEARTBEAT_NAME }, async ({ db }) => {
  const nowMs = Date.now()
  try {
    const result = await runUsageRollup(db, {
      nowMs,
      getZones: (ids) => getLocationZones(db, ids, { nowMs }),
    })
    return { body: { ok: true, ...result }, outcome: result }
  } catch (err) {
    logError('cron-app-usage-rollup', 'rollup failed', { message: err?.message || String(err) })
    return { ok: false, body: { ok: false, error: 'Rollup failed' } }
  }
})
