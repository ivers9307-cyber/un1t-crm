// FEES.1 — the hourly class-fees cron. Each un1t.online studio with fees
// switched on acts on its own clock:
//   - at its detect hour (23:00): lists the day's no-shows and late cancels
//     (class_fees) and emails the review contacts;
//   - every hour: charges the fees that are due (17:00 the next day, retries
//     7 days later, and any charge left in doubt, resumed with its own key),
//     unless charging is paused or un1t.online writes are off.
// Outcome counts only: no names, no amounts, no un1t.online words.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { locationsWithSource } from '@/lib/membership/locations-for-source'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { readClassFeeContext, detectClassFees, sendReviewEmail, chargeDueClassFees } from '@/lib/class-fees-run'
import { localHourIn } from '@/lib/class-fees'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const CRON_NAME = 'class-fees'
const BUDGET_MS = 240_000

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const started = Date.now()
  const db = createServerClient()
  const { eligible, error: locErr } = await locationsWithSource(db, 'un1t_online', { module: CRON_NAME })
  if (locErr) {
    logError(CRON_NAME, 'failed to list locations', { err: locErr })
    return NextResponse.json({ success: false, error: 'Could not list locations' }, { status: 500 })
  }

  const outcome = { studios: 0, fees_off: 0, detected_runs: 0, inserted: 0, emails: 0, charge_runs: 0, charged: 0, retry_scheduled: 0, outstanding: 0, in_doubt: 0, failed: 0, deferred_budget: 0 }
  for (const [i, loc] of (eligible || []).entries()) {
    if (Date.now() - started > BUDGET_MS) { outcome.deferred_budget = eligible.length - i; break }
    outcome.studios++
    try {
      const ctx = await readClassFeeContext(db, loc.id)
      if (!ctx.settings.enabled) { outcome.fees_off++; continue }
      const nowMs = Date.now()
      if (localHourIn(nowMs, ctx.zone) === ctx.settings.detectHour) {
        const found = await detectClassFees(db, { locationId: loc.id, nowMs })
        outcome.detected_runs++
        outcome.inserted += found.inserted
        const mail = await sendReviewEmail(db, {
          locationId: loc.id, location: ctx.location, settings: ctx.settings, zone: ctx.zone, nowMs,
          undecidedCount: found.undecided.length,
        })
        if (mail.sent) outcome.emails++
      }
      if (ctx.settings.chargingPaused) continue
      const { settings: writeSettings } = await readUn1tWriteSettings(db, loc.id)
      if (!writeSettings.writesEnabled) continue
      const charged = await chargeDueClassFees(db, { locationId: loc.id, nowMs, settings: ctx.settings, zone: ctx.zone })
      outcome.charge_runs++
      outcome.charged += charged.charged
      outcome.retry_scheduled += charged.retry_scheduled
      outcome.outstanding += charged.outstanding
      outcome.in_doubt += charged.in_doubt
    } catch (err) {
      outcome.failed++
      logError(CRON_NAME, 'studio run failed', { locationId: loc.id, code: err?.code ?? err?.name ?? 'threw' })
    }
  }

  await stampHeartbeat(CRON_NAME, outcome)
  return NextResponse.json({ success: true, ...outcome })
}
