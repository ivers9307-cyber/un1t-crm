// src/app/api/cron/receipt-coverage-weekly/route.js
//
// RCOV.P0/P1 — Friday 08:00 in each Xero-connected location's own zone.
// TZ.6: vercel.json fires this hourly (it used to fire at 07:00 AND 08:00 UTC
// on Fridays to straddle Dublin's DST); the daily-slot gate
// (src/lib/cron-daily-slot.js, a LOCAL-anchored slot) lets each connection's
// location run in its Friday 08:xx local hour, once per local day, which for a
// Europe/Dublin location is exactly the firing the old Dublin-hour gate picked.
// The per-location claim replaces the old global alreadyRanToday check: a
// retry or manual re-fire the same day does nothing. (W0.7: the report is sent per organisation
// to org_settings.ops_alert_emails via sendOpsAlert; the old env
// recipient RECEIPT_COVERAGE_REPORT_TO is retired, so nothing is
// checked up-front here any more.)
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
import { runCoveragePull } from '@/lib/recon/pull'
import { sweepSubmittedLines, seedHunts } from '@/lib/recon/statuses'
import { gateDailySlot, slotFor } from '@/lib/cron-daily-slot'
import { dayStrIn } from '@/lib/location-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const db = createServerClient()

  // TZ.6 — which locations are at their Friday 08:00 local slot this tick
  // (claimed, so never twice in one local day). An unreadable zone acts for
  // nobody. No heartbeat here either way (see the note above).
  const gate = await gateDailySlot(db, 'receipt-coverage-weekly', { module: 'receipt-coverage-weekly' })
  if (!gate.ok) return NextResponse.json({ success: false, error: 'locations unreadable', slot: gate.summary }, { status: 500 })
  if (gate.slots.size === 0) {
    return NextResponse.json({ success: !gate.faulted, skipped: true, slot: gate.summary }, { status: gate.faulted ? 500 : 200 })
  }

  // Before mig 720 lands there is no claim, so a Europe/Dublin slot taken on
  // the legacy fallback keeps the old guard: skip it if a cron pull already
  // started on that studio's day (a retry or manual re-fire inside the hour).
  const fallbackSlots = [...gate.slots.values()].filter((s) => s.fallback)
  const ranToday = new Set()
  if (fallbackSlots.length) {
    const { data: lastCron, error: lastErr } = await db
      .from('recon_runs')
      .select('started_at')
      .eq('trigger', 'cron')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    // An unreadable history runs, as main's guard did: a duplicate Friday pull
    // (its run claim dedupes per location) beats a silent skip with no heartbeat.
    if (lastErr) console.error('[receipt-coverage-weekly] recon_runs unreadable; running the fallback slots', lastErr.message)
    for (const s of fallbackSlots) {
      if (!lastErr && lastCron && dayStrIn(lastCron.started_at, s.zone) === s.day) ranToday.add(s.locationId)
    }
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
    if (!slotFor(gate.slots, conn.location_id)) continue // TZ.6: not this location's slot
    if (ranToday.has(conn.location_id)) continue // pre-720 fallback: already pulled today
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
    success: errors.length === 0 && !gate.faulted,
    data: { locations: perLocation.length, perLocation, errors },
  }, { status: gate.faulted ? 500 : 200 })
}
