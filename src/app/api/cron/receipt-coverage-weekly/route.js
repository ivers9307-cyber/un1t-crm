// src/app/api/cron/receipt-coverage-weekly/route.js
//
// RCOV.P0/P1 — Friday 08:00 Europe/Dublin. vercel.json fires this at
// 07:00 AND 08:00 UTC on Fridays (DST straddle); the Dublin-hour gate
// makes exactly one firing run, and the alreadyRanToday check absorbs
// retries/manual re-fires. Env RECEIPT_COVERAGE_REPORT_TO is REQUIRED
// — checked up-front so a misconfig fails loudly, before any pulls
// (the finalizer below needs it too, once the hunt queue drains).
//
// RE-SEQUENCED for P1's hunt engine: this cron now only pulls, sweeps,
// and seeds — per location, runCoveragePull() → sweepSubmittedLines()
// (flip rejected-backed submitted lines to needs_attention) →
// seedHunts() (queue uncovered/not_found lines for the drain cron;
// since QSTASH.10 seedHunts also fire-and-forget publishes a QStash
// push per seeded row — capped — onto the parallelism-1 `receipt-hunts`
// queue, so hunting starts within seconds of the seed).
// The weekly report + heartbeat stamp used to happen here, right
// after the pull; they now happen in process-receipt-hunts' finalizer
// once the seeded hunt queue actually drains, so the report reflects
// post-hunt coverage instead of the pre-hunt snapshot this cron used
// to email. See that cron for the report/heartbeat logic.
//
// NOTE on heartbeats: this file intentionally does NOT call
// stampHeartbeat — its heartbeat is stamped by process-receipt-hunts'
// finalizer when the weekly cycle actually completes, not by this
// cron. (The CLAUDE.md invariant "every cron with a cron_heartbeats
// row calls stampHeartbeat" — checked via `grep -L stampHeartbeat
// src/app/api/cron/*/route.js` listing only health-check — now also
// expects this file to appear in that grep; the expectation moves
// with the heartbeat to process-receipt-hunts.)
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { dublinNowMinutes, dublinDayStr, dublinTodayStr } from '@/lib/dublin-time'
import { runCoveragePull } from '@/lib/recon/pull'
import { sweepSubmittedLines, seedHunts } from '@/lib/recon/statuses'
import { shouldRunFridayCron, reportRecipients } from '@/lib/recon/report-email'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  reportRecipients() // throws if env missing — fail loudly before any work

  const db = createServerClient()

  const { data: lastCron } = await db
    .from('recon_runs')
    .select('started_at')
    .eq('trigger', 'cron')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const alreadyRanToday = !!lastCron && dublinDayStr(lastCron.started_at) === dublinTodayStr()

  if (!shouldRunFridayCron({ dublinMinutes: dublinNowMinutes(), alreadyRanToday })) {
    return NextResponse.json({ success: true, skipped: true })
  }

  const { data: conns, error: connErr } = await db
    .from('xero_connections')
    .select('location_id, location:location_id(id, name)')
  if (connErr) {
    console.error('[receipt-coverage-weekly] connections load failed', connErr)
    return NextResponse.json({ success: false, error: connErr.message }, { status: 500 })
  }

  const perLocation = []
  const errors = []
  for (const conn of conns || []) {
    const locationName = conn.location?.name || conn.location_id
    try {
      const summary = await runCoveragePull(db, conn.location_id, { trigger: 'cron' })
      const { flagged } = await sweepSubmittedLines(db, conn.location_id)
      const { seeded } = await seedHunts(db, conn.location_id)
      perLocation.push({ locationName, seeded, flagged, anomalies: summary.anomalies.length })
    } catch (e) {
      console.error('[receipt-coverage-weekly] pull failed', locationName, e)
      errors.push({ locationName, error: String(e?.message || e) })
    }
  }

  return NextResponse.json({
    success: errors.length === 0,
    data: { locations: perLocation.length, perLocation, errors },
  })
}
