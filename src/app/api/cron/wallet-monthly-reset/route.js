// GET /api/cron/wallet-monthly-reset — monthly wallet expiry-reset
// (INTEG-C2a). The wallet is a monthly usage budget: at each Dublin
// billing-month boundary, unused credit EXPIRES via an explicit
// 'expiry_reset' ledger entry (never silently) and the wallet's
// period_start advances to the new month.
//
// SELF-GATING: scheduled daily at 05:10 UTC, but only acts on a
// wallet whose period boundary has been crossed — shouldReset() is
// true when today (Dublin) has entered a month period_start hasn't
// reached (the 1st, or ANY later day if earlier runs were missed —
// a stale-past-a-boundary period_start makes missed days
// self-healing). Idempotent per period: once period_start is
// advanced, a same-day/same-month rerun matches nothing.
//
// PARTICIPATION: only wallets of locations with an ACTIVE tier
// pinning in location_plans (mig 413) are touched. Unpinned
// locations — every UN1T location today — are skipped entirely
// (zero behaviour change).
//
// Per acted-on wallet, in order:
//   1. balance != 0 → post 'expiry_reset' via the wallet_apply RPC.
//      The RPC computes -balance UNDER THE ROW LOCK so the balance
//      lands on exactly 0 (this includes bringing a negative
//      grace-floor balance up to 0 — settling that debt is the
//      deferred Stripe/VAT-invoice leg's job), and stamps the ledger
//      row with the OLD period (the month whose credit expired).
//   2. Advance period_start to the current month. If this update
//      fails after a successful reset, the next run sees balance 0 +
//      stale period_start and just advances the period — no
//      duplicate ledger entry (the RPC no-ops at balance 0).
//
// defineCron owns the secret check. Heartbeat on a clean run only (any
// failure must surface as staleness — 31-day window + 3-day grace, mig 420).
// A run where every acted-on wallet failed answers 500; one where only some
// failed answers success but leaves the heartbeat unstamped.

import { defineCron } from '@/lib/define-cron'
import { logError } from '@/lib/log'
import { todayStrIn, PLATFORM_TZ } from '@/lib/location-time'
import { applyWalletEntry, shouldReset, currentPeriodStart } from '@/lib/wallet'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'wallet-monthly-reset' }, async ({ db }) => {
  const today = todayStrIn(PLATFORM_TZ) // D5: the platform billing calendar (PLATFORM_TZ)
  const newPeriod = currentPeriodStart(today)

  // One wallet per location, so both selects are bounded by the
  // location count (dozens) — far under the 1,000-row cap; ordered
  // for deterministic processing.
  const { data: wallets, error: walletsError } = await db
    .from('wallets')
    .select('location_id, balance_cents, period_start')
    .order('location_id')
  if (walletsError) {
    logError('wallet-monthly-reset', 'wallets fetch failed; nothing reset, heartbeat not stamped', { err: walletsError })
    return { ok: false, body: { error: 'Could not read wallets' } }
  }

  const { data: pins, error: pinsError } = await db
    .from('location_plans')
    .select('location_id, version:plan_versions!plan_version_id(plan:plans!plan_id(kind))')
    .eq('active', true)
  if (pinsError) {
    logError('wallet-monthly-reset', 'location_plans fetch failed; nothing reset, heartbeat not stamped', { err: pinsError })
    return { ok: false, body: { error: 'Could not read location plans' } }
  }
  const pinnedLocationIds = new Set(
    (pins || [])
      .filter((row) => row.version?.plan?.kind === 'tier')
      .map((row) => row.location_id)
  )

  let reset = 0
  let advanced = 0
  let skipped = 0
  let failed = 0

  for (const wallet of (wallets || [])) {
    if (!pinnedLocationIds.has(wallet.location_id) || !shouldReset(wallet, today)) {
      skipped += 1
      continue
    }

    try {
      if (wallet.balance_cents !== 0) {
        await applyWalletEntry(db, {
          locationId: wallet.location_id,
          kind: 'expiry_reset',
          note: `Unused credit expired at billing-month boundary (period ${wallet.period_start || 'unset'} -> ${newPeriod})`,
        })
        reset += 1
      } else {
        advanced += 1
      }

      const { error: updateError } = await db
        .from('wallets')
        .update({ period_start: newPeriod, updated_at: new Date().toISOString() })
        .eq('location_id', wallet.location_id)
      if (updateError) throw new Error(`period_start advance failed: ${updateError.message}`)
    } catch (e) {
      failed += 1
      console.error(`[wallet-monthly-reset] wallet ${wallet.location_id}: ${e.message}`)
    }
  }

  const body = { today, newPeriod, reset, advanced, skipped, failed }
  // Every wallet due a reset failed (a wallet whose expiry posted but whose
  // period advance failed counts in both reset and failed).
  if (failed > 0 && failed === (wallets || []).length - skipped) {
    return { ok: false, body: { ...body, error: 'Every wallet due a reset failed' } }
  }
  return { body, outcome: { today, reset, advanced, skipped }, stamp: failed === 0 }
})
