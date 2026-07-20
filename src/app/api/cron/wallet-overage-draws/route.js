// GET /api/cron/wallet-overage-draws — daily overage draw poster
// (INTEG-C3). Runs at 03:10 UTC, deliberately AFTER the 02:40
// usage-rollup cron, so yesterday's usage_rollups_daily rows are
// complete before they are priced.
//
// For each location with an ACTIVE tier pinning in location_plans
// (unpinned locations — every UN1T location today — are never
// touched), per billing meter (wa_template_send / email_send /
// ai_message):
//
//   1. Month-to-date usage for the billing month CONTAINING YESTERDAY
//      (Dublin). Anchoring on yesterday makes the run on the 1st a
//      FINAL SWEEP of the previous month: the last rollup for its
//      final day lands at 02:40 on the 1st, this cron prices it at
//      03:10, and the wallet-monthly-reset cron (05:10) only then
//      expires the remaining balance. wa/email come from
//      usage_rollups_daily; ai_message is the COUNT of
//      allowance-eligible usage_events rows (source !=
//      'assistant_chat') — the shared/plans.js derivation.
//   2. Overage units = max(0, MTD usage − pinned allowance), priced
//      at plan_versions.unit_rates_cents. WhatsApp overage is ALL
//      priced at wa_marketing: the rollup carries no
//      marketing/utility split (see the TODO in
//      src/lib/wallet-enforcement.js). Email is per-1k prorated with
//      the total rounded UP to the cent; AI is per message.
//   3. Draw delta = cumulative MTD overage cost − cents already drawn
//      for that meter this period (wallet_transactions kind='draw',
//      period = the billing month). ≥ 1 cent → ONE draw via the
//      wallet_apply RPC (kind='draw', negative cents, meter/qty/
//      unit_rate populated). IDEMPOTENT BY CONSTRUCTION: a rerun
//      recomputes cumulative-minus-drawn and posts nothing new.
//   4. Grace floor: a draw that would land the balance below −1000
//      cents is CLAMPED so the balance lands exactly at −1000, and
//      the unbilled shortfall is logged loudly — collecting it is the
//      deferred Stripe/VAT-invoice leg's problem, not this cron's.
//      Belt-and-braces: if the RPC still raises its grace-floor error
//      (concurrent balance movement), the balance is re-read and the
//      clamped draw retried once.
//
// SAFETY GUARD: a wallet whose period_start does not match the
// billing month being priced means the wallet-monthly-reset cron is
// behind (or the pin/wallet is brand new mid-transition). Posting a
// draw then would stamp the ledger with the wrong period and later
// double-bill the delta, so the location is SKIPPED with a loud log
// — the next healthy day catches up via cumulative-minus-drawn.
//
// Bearer CRON_SECRET. Heartbeat only on a clean run (mig 417 seeds
// the row: 86400s window + 21600s grace).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { dublinTodayStr, addDaysISO } from '@/lib/dublin-time'
import { getLocationPlan } from '@/lib/plans'
import { getWallet, applyWalletEntry } from '@/lib/wallet'
import {
  BILLING_METERS,
  billingMonthWindow,
  sumRollupUsage,
  countAiMessages,
  sumDrawnByMeter,
  priceOverageCents,
  drawDeltaCents,
  clampDrawToFloor,
  isGraceFloorError,
} from '@/lib/wallet-enforcement'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// unit_rates_cents key used per meter. WhatsApp: wa_marketing for ALL
// wa overage until the rollup carries the marketing/utility split.
const RATE_KEY_BY_METER = {
  wa_template_send: 'wa_marketing',
  email_send: 'email_per_1k',
  ai_message: 'ai_message',
}

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const today = dublinTodayStr()
  // Billing month = the Dublin month containing YESTERDAY (final-sweep
  // semantics on the 1st — see header).
  const yesterday = addDaysISO(today, -1)
  const window = billingMonthWindow(yesterday)

  // Locations with an active TIER pinning (the wallet-monthly-reset
  // selection shape). Bounded by the location count — far under 1k.
  const { data: pins, error: pinsError } = await db
    .from('location_plans')
    .select('location_id, version:plan_versions!plan_version_id(plan:plans!plan_id(kind))')
    .eq('active', true)
  if (pinsError) {
    console.error('[wallet-overage-draws] location_plans fetch failed:', pinsError.message)
    return NextResponse.json({ success: false, error: pinsError.message }, { status: 500 })
  }
  const pinnedLocationIds = [...new Set(
    (pins || [])
      .filter((row) => row.version?.plan?.kind === 'tier')
      .map((row) => row.location_id)
  )].sort()

  const stats = {
    month: window.monthStart,
    locations: pinnedLocationIds.length,
    draws: 0,
    drawnCents: 0,
    shortfallCents: 0,
    skippedPeriodMismatch: 0,
    failed: 0,
  }

  for (const locationId of pinnedLocationIds) {
    try {
      const plan = await getLocationPlan(db, locationId)
      if (!plan) continue // pin deactivated between the list and here

      const wallet = await getWallet(db, locationId)
      if (wallet?.period_start && String(wallet.period_start) !== window.monthStart) {
        // Reset cron behind / period out of step — do NOT post into the
        // wrong period (see the safety-guard note in the header).
        console.error(
          `[wallet-overage-draws] location ${locationId}: wallet period_start ${wallet.period_start} != ` +
          `billing month ${window.monthStart} — skipping (is wallet-monthly-reset healthy?)`
        )
        stats.skippedPeriodMismatch += 1
        continue
      }

      const [rollups, aiCount, drawn] = await Promise.all([
        sumRollupUsage(db, locationId, window),
        countAiMessages(db, locationId, window),
        sumDrawnByMeter(db, locationId, window.monthStart),
      ])
      const usageByMeter = {
        wa_template_send: rollups.wa_template_send,
        email_send: rollups.email_send,
        ai_message: aiCount,
      }

      let balance = wallet?.balance_cents ?? 0

      for (const meter of BILLING_METERS) {
        const allowance = Number(plan.resolved.allowances?.[meter]) || 0
        const overageUnits = Math.max(0, (Number(usageByMeter[meter]) || 0) - allowance)
        // waRateKey defaults to wa_marketing — the documented
        // no-split-in-rollups pricing decision (see RATE_KEY_BY_METER).
        const cumulativeCents = priceOverageCents(meter, overageUnits, plan.resolved.unitRatesCents)
        const delta = drawDeltaCents(cumulativeCents, drawn[meter] || 0)
        if (delta < 1) continue

        const rateKey = RATE_KEY_BY_METER[meter]
        const unitRateCents = Math.round(Number(plan.resolved.unitRatesCents?.[rateKey]) || 0)
        const post = async (cents) => applyWalletEntry(db, {
          locationId,
          kind: 'draw',
          amountCents: -cents,
          meter,
          // qty = cumulative MTD overage units at post time; the AMOUNT
          // is the delta vs cents already drawn this period (the note
          // spells this out for whoever reads the ledger).
          qty: overageUnits,
          unitRateCents,
          note:
            `INTEG-C3 daily overage draw (${window.monthStart} month): ${overageUnits} ${meter} overage units ` +
            `MTD at rate key ${rateKey}=${unitRateCents}c → cumulative ${cumulativeCents}c, ` +
            `previously drawn ${drawn[meter] || 0}c, this draw ${cents}c.`,
        })

        const { drawable, shortfall } = clampDrawToFloor(delta, balance)
        if (shortfall > 0) {
          stats.shortfallCents += shortfall
          console.error(
            `[wallet-overage-draws] location ${locationId} ${meter}: draw of ${delta}c clamped to ${drawable}c ` +
            `at the -€10 grace floor — ${shortfall}c UNBILLED (deferred invoice leg's problem). Top up the wallet.`
          )
        }
        if (drawable < 1) continue

        try {
          balance = await post(drawable)
          stats.draws += 1
          stats.drawnCents += drawable
        } catch (e) {
          if (!isGraceFloorError(e)) throw e
          // Concurrent balance movement between our read and the RPC's
          // row lock — re-read and retry ONCE with a re-clamped amount.
          const fresh = await getWallet(db, locationId)
          const { drawable: retryable, shortfall: retryShortfall } =
            clampDrawToFloor(delta, fresh?.balance_cents ?? 0)
          stats.shortfallCents += retryShortfall
          if (retryShortfall > 0) {
            console.error(
              `[wallet-overage-draws] location ${locationId} ${meter}: grace-floor race — ` +
              `${retryShortfall}c UNBILLED after re-clamp.`
            )
          }
          if (retryable >= 1) {
            balance = await post(retryable)
            stats.draws += 1
            stats.drawnCents += retryable
          }
        }
      }
    } catch (e) {
      stats.failed += 1
      console.error(`[wallet-overage-draws] location ${locationId} failed:`, e?.message || e)
    }
  }

  if (stats.failed === 0) await stampHeartbeat('wallet-overage-draws', stats)
  return NextResponse.json({ success: true, ...stats })
}
