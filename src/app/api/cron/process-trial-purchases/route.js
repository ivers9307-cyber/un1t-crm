// PAIDTRIAL.1 — sweeper for trial_purchases (the class-bookings shape). Push
// delivery via QStash is the fast path; this cron is the delivery guarantee:
// it re-queues rows a dead run left in 'processing', claims anything QStash
// missed, and stamps the heartbeat. Bounded batch per run.
// TRIALSTUDIO.7 — then it settles the Hatch Street (un1t.online) rows off the
// un1t_transactions mirror and expires the abandoned ones. A sweep that could
// not read its rows skips the heartbeat (like the reaper); a per-row failure
// is counted in un1t_errors and does not. un1t_race_lost (an overlapping
// sweep settled off the same payment) and un1t_password_pending (a paid buyer
// whose set-password step did not finish) are counts, never faults.
// STILL39SEQ.1 — last, the checkout €39 purchase sequence sweep (an ARM with
// its own heartbeat row, 'trial-checkout-purchase-sweep'): stamped only when
// the sweep returned ok, in its own try/catch, after the parent's stamp, so
// neither can stop the other.
// NEWSTART.1f — and after it, the stalled /newstart claim sweep (an ARM,
// heartbeat 'corp-promo-stalled-sweep'): files Glofox promo claims stuck in
// 'processing' for 15 minutes as help_requested/stalled and alerts staff.
// Same rule: own try/catch, stamped only when ok, after the other stamps.
// BLACKFRIDAY.9f — last, the Black Friday offer purchase sweep (an ARM,
// heartbeat 'un1t-offer-purchase-sweep', mig 828): for each un1t.online
// studio, records off-page offer sales and settles page rows off the
// un1t_transactions mirror, then runs the buyer's set-password step. It lives
// here, not in un1t-online-sync, because that step is a un1t.online write and
// the sync is write-fenced (tests/un1t-online-write-guard.test.js). Each studio
// in its own try/catch; stamped only when the studio list was read and every
// studio's sweep returned ok (failed / passwordPending are counts, not faults).
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { claimAndProcessTrialPurchase, MAX_ATTEMPTS } from '@/lib/trial-purchase-queue'
import { settleUn1tTrialPurchases } from '@/lib/trial-purchase-un1t-settle'
import { sweepCheckoutTrialPurchases } from '@/lib/trial-checkout-purchase-sweep'
import { sweepStalledGlofoxCorpClaims } from '@/lib/corp-promo-stalled-sweep'
import { sweepUn1tOfferPurchases } from '@/lib/un1t-offer-purchases'
import { locationsWithSource } from '@/lib/membership/locations-for-source'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const STALE_MS = 10 * 60_000
const FRESH_ROW_GRACE_MS = 30_000
const CHECKOUT_SWEEP_HEARTBEAT = 'trial-checkout-purchase-sweep'
const STALLED_SWEEP_HEARTBEAT = 'corp-promo-stalled-sweep'
const OFFER_SWEEP_HEARTBEAT = 'un1t-offer-purchase-sweep'
const OFFER_COUNT_KEYS = ['checked', 'recorded', 'matchedPage', 'expired', 'failed', 'passwordPending']

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const db = createServerClient()
  const stats = { reaped: 0, processed: 0, granted: 0, review: 0, failed: 0, reap_failed: 0, un1t_settled: 0, un1t_expired: 0, un1t_errors: 0, un1t_race_lost: 0, un1t_password_pending: 0, un1t_read_failed: 0 }
  try {
    const staleBefore = new Date(Date.now() - STALE_MS).toISOString()
    try {
      const { data: requeued, error: requeueErr } = await db.from('trial_purchases').update({ status: 'queued' })
        .eq('status', 'processing').lt('updated_at', staleBefore).lt('attempts', MAX_ATTEMPTS).select('id')
      if (requeueErr) { stats.reap_failed = 1; logError('process-trial-purchases', 'reaper requeue failed', { err: requeueErr }) }
      else stats.reaped = (requeued || []).length
      const { error: reviewErr } = await db.from('trial_purchases').update({ status: 'needs_review', last_error: 'max_attempts_stuck_processing' })
        .eq('status', 'processing').lt('updated_at', staleBefore).gte('attempts', MAX_ATTEMPTS)
      if (reviewErr) { stats.reap_failed = 1; logError('process-trial-purchases', 'reaper needs_review flag failed', { err: reviewErr }) }
    } catch (e) {
      stats.reap_failed = 1
      logError('process-trial-purchases', 'reaper threw', { err: e })
    }

    const { data: rows, error: rowsErr } = await db.from('trial_purchases')
      .select('*').eq('status', 'queued').lt('created_at', new Date(Date.now() - FRESH_ROW_GRACE_MS).toISOString())
      .order('created_at', { ascending: true }).limit(25)
    if (rowsErr) {
      logError('process-trial-purchases', 'queue read failed; nothing claimed, heartbeat not stamped', { err: rowsErr })
      return NextResponse.json({ success: false, error: 'Could not read the trial purchase queue', ...stats }, { status: 500 })
    }
    for (const row of rows || []) {
      const res = await claimAndProcessTrialPurchase(db, row)
      if (res.status === 'skipped') continue
      stats.processed++
      if (res.status === 'failed') { stats.failed++; logWarn('process-trial-purchases', `row ${row.id} threw`, { err: res.error }) }
      else if (res.outcome === 'granted') stats.granted++
      else if (res.outcome === 'needs_review') stats.review++
      else stats.failed++
    }
    try {
      const un1t = await settleUn1tTrialPurchases(db)
      stats.un1t_settled = un1t.settled
      stats.un1t_expired = un1t.expired
      stats.un1t_errors = un1t.errors
      stats.un1t_race_lost = un1t.raceLost
      stats.un1t_password_pending = un1t.passwordPending
      if (un1t.readFailed) stats.un1t_read_failed = 1
    } catch (e) {
      // The sweeper never throws by contract; a bug here must not crash the run.
      stats.un1t_errors++
      logError('process-trial-purchases', 'un1t settle sweep threw', { err: e })
    }
    if (stats.reap_failed === 0 && stats.un1t_read_failed === 0) await stampHeartbeat('process-trial-purchases', stats)
    const sweep = await runCheckoutPurchaseSweep(db)
    const stalled = await runStalledClaimSweep(db)
    const offers = await runOfferPurchaseSweep(db)
    return NextResponse.json({ success: true, ...stats, ...sweep, ...stalled, ...offers })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}

// STILL39SEQ.1 — the arm. Returns its counts for the response; never throws.
async function runCheckoutPurchaseSweep(db) {
  try {
    const res = await sweepCheckoutTrialPurchases(db)
    if (res?.ok) {
      const { locations, checked, enrolled, already, failed } = res
      try {
        await stampHeartbeat(CHECKOUT_SWEEP_HEARTBEAT, { locations, checked, enrolled, already, failed })
      } catch (e) {
        logError('process-trial-purchases', 'checkout purchase sweep stamp threw', { errName: e?.name ?? null })
      }
    }
    return { checkout_seq_ok: Boolean(res?.ok), checkout_seq_checked: res?.checked || 0, checkout_seq_enrolled: res?.enrolled || 0 }
  } catch (e) {
    logError('process-trial-purchases', 'checkout purchase sweep threw', { errName: e?.name ?? null })
    return { checkout_seq_ok: false, checkout_seq_checked: 0, checkout_seq_enrolled: 0 }
  }
}

// NEWSTART.1f — the stalled-claim arm. Returns its counts; never throws.
async function runStalledClaimSweep(db) {
  try {
    const res = await sweepStalledGlofoxCorpClaims(db)
    if (res?.ok) {
      const { checked, filed, failed } = res
      try {
        await stampHeartbeat(STALLED_SWEEP_HEARTBEAT, { checked, filed, failed })
      } catch (e) {
        logError('process-trial-purchases', 'stalled claim sweep stamp threw', { errName: e?.name ?? null })
      }
    }
    return { stalled_claims_ok: Boolean(res?.ok), stalled_claims_checked: res?.checked || 0, stalled_claims_filed: res?.filed || 0 }
  } catch (e) {
    logError('process-trial-purchases', 'stalled claim sweep threw', { errName: e?.name ?? null })
    return { stalled_claims_ok: false, stalled_claims_checked: 0, stalled_claims_filed: 0 }
  }
}

// BLACKFRIDAY.9f — the offer purchase arm. Returns its counts; never throws.
async function runOfferPurchaseSweep(db) {
  const totals = { locations: 0, checked: 0, recorded: 0, matchedPage: 0, expired: 0, failed: 0, passwordPending: 0 }
  const answer = (ok) => ({ offer_sweep_ok: ok, offer_sweep_recorded: totals.recorded, offer_sweep_matched: totals.matchedPage })
  try {
    const { eligible, error } = await locationsWithSource(db, 'un1t_online', { module: 'process-trial-purchases' })
    if (error) {
      // An unread studio list is not "no studios": no stamp.
      logError('process-trial-purchases', 'offer purchase sweep: un1t.online studios unreadable', { code: error?.code ?? null })
      return answer(false)
    }
    let clean = true
    for (const loc of eligible || []) {
      try {
        const res = await sweepUn1tOfferPurchases(db, loc.id)
        if (!res?.ok) { clean = false; continue }
        totals.locations++
        for (const k of OFFER_COUNT_KEYS) totals[k] += res[k] || 0
      } catch (e) {
        clean = false
        logError('process-trial-purchases', 'offer purchase sweep threw', { locationId: loc.id, errName: e?.name ?? null })
      }
    }
    if (clean) {
      try {
        await stampHeartbeat(OFFER_SWEEP_HEARTBEAT, totals)
      } catch (e) {
        logError('process-trial-purchases', 'offer purchase sweep stamp threw', { errName: e?.name ?? null })
      }
    }
    return answer(clean)
  } catch (e) {
    logError('process-trial-purchases', 'offer purchase arm threw', { errName: e?.name ?? null })
    return answer(false)
  }
}
