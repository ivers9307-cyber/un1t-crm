// LIEU.1 — nightly Vercel cron (03:40 UTC). Credits time in lieu for every
// completed FTE shift on a Sunday or a public holiday in the last 14 days
// (src/lib/lieu-credits.js runLieuCreditSweep), once per shift assignment.
// Auth: CRON_SECRET.
//
// `?days=N` (1..400) widens the window for a hand-run backfill; the sweep is
// idempotent, so a wider window only adds what is missing.
//
// Heartbeat: stamped on a sweep that read the estate; NOT stamped when the
// locations read failed or every studio failed (a green heartbeat over a sweep
// that credited nothing is the failure the row exists to catch, the
// extend-roster-horizon rule). A partial failure stamps and rides in
// last_outcome.failures.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runLieuCreditSweep, LIEU_SWEEP_LOOKBACK_DAYS, LIEU_SWEEP_MAX_LOOKBACK_DAYS } from '@/lib/lieu-credits'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const url = new URL(request.url)
  const daysRaw = url.searchParams.get('days')
  let lookbackDays = LIEU_SWEEP_LOOKBACK_DAYS
  if (daysRaw !== null) {
    const n = Number(daysRaw)
    if (!Number.isInteger(n) || n < 1 || n > LIEU_SWEEP_MAX_LOOKBACK_DAYS) {
      return NextResponse.json({ success: false, error: `days must be an integer from 1 to ${LIEU_SWEEP_MAX_LOOKBACK_DAYS}` }, { status: 400 })
    }
    lookbackDays = n
  }

  const db = createServerClient()
  let stats
  try {
    stats = await runLieuCreditSweep(db, { lookbackDays })
  } catch (err) {
    logWarn('lieu-credits', 'sweep threw', { err })
    return NextResponse.json({ success: false, error: err?.message || 'Lieu credit sweep failed' }, { status: 500 })
  }

  if (!stats.ok) {
    logWarn('lieu-credits', 'sweep failed — heartbeat not stamped', { stats })
    return NextResponse.json({ success: false, error: stats.error || 'Lieu credit sweep failed', stats }, { status: 500 })
  }

  await stampHeartbeat('lieu-credits', stats).catch((err) =>
    logWarn('lieu-credits', 'heartbeat stamp failed', { err: err?.message }))
  return NextResponse.json({ success: true, stats })
}
