// INTEG-C3 — per-location wallet/allowance ENFORCEMENT (overage draws
// + empty-wallet semantics). Sits on top of INTEG-C1 (plans, mig 413)
// and INTEG-C2a (wallets + wallet_apply, mig 414).
//
// Model (Richard's spec, 2026-07-19, all final):
//   • Enforcement applies ONLY to locations with an ACTIVE tier
//     pinning in location_plans. Unpinned locations — every UN1T
//     location today — get getBillingState() === null and every
//     caller treats null as "bypass everything": zero behaviour
//     change is a hard requirement.
//   • Monthly allowance per meter (plan_versions.allowances:
//     wa_template_send / email_send / ai_message) is consumed first;
//     beyond allowance, usage draws down the prepaid wallet at
//     plan_versions.unit_rates_cents (wa_marketing / wa_utility /
//     email_per_1k / ai_message). Overage is a SOFT band — allowed
//     while the wallet has funds, not a cut-off.
//   • Draws are DAILY ROLLUP POSTS, not per-send: one draw per meter
//     per location per day, posted by /api/cron/wallet-overage-draws
//     from usage_rollups_daily via the wallet_apply RPC (the ONLY
//     wallet write path). Idempotent by construction: each run
//     recomputes cumulative month-to-date overage cost and posts only
//     the difference vs cents already drawn this period.
//   • EMPTY-WALLET semantics (balance ≤ 0 AND allowance exhausted for
//     that meter): marketing sends PAUSE first; Mia finishes the turn
//     in flight and then pauses via softHandoff reason 'wallet_empty'
//     (the check runs at turn-START, so an in-flight turn always
//     completes); TRANSACTIONAL sends continue against the −€10 grace
//     floor. At/below the floor transactional sends STILL GO OUT
//     (fail-open — billing must never kill a booking confirmation)
//     but the caller logs loudly ('grace_exhausted_fail_open').
//   • Every IO check FAILS OPEN on any error (the usage-caps.js
//     posture): checkSpend() never throws and answers allow:true on
//     any infrastructure failure.
//
// COMPOSITION with the org hard caps (SAAS4-M2, src/lib/usage-caps.js):
// these are SIBLINGS, not alternatives. The org-level hard caps and
// this per-location wallet enforcement BOTH apply at their seams —
// whichever trips first stops the send. Nothing here reads or
// modifies the org-cap logic.
//
// Meter derivations (aligned with shared/plans.js):
//   wa_template_send / email_send — usage_rollups_daily rows (Dublin
//     calendar-month window). NOTE: the rollup is recomputed nightly
//     (02:40 UTC) for yesterday+today, so live checks can lag today's
//     sends by up to a day — accepted; the daily draw cron runs right
//     after the rollup, when yesterday is complete.
//   ai_message — COUNT of usage_events rows, meter='anthropic_tokens',
//     source != 'assistant_chat' (allowance-exempt per Richard
//     2026-07-19). shared/plans.js documents this derivation; there is
//     no rollup meter for it. CAVEAT (documented): one usage_events
//     row = one Anthropic API call, and a tool-using Mia turn makes
//     several calls, so this over-counts "messages". Consistent on
//     both the check and the draw side, so enforcement is coherent —
//     revisit when billing wants true per-reply counts.
//
// WhatsApp marketing/utility overage split: usage_rollups_daily's
// wa_template_send meter counts ALL outbound template messages with no
// marketing/utility dimension (mig 415 derives it from
// whatsapp_messages direction+message_type only). Until the rollup
// carries the split, ALL WhatsApp overage is priced at the
// wa_marketing rate (the conservative-for-us, documented-in-PR
// choice). TODO(INTEG-C3): split the rollup by Meta conversation
// category (or broadcast_id IS NOT NULL as a proxy) and price
// wa_utility overage at unit_rates_cents.wa_utility.

import { getLocationPlan } from './plans'
import { getWallet, currentPeriodStart, nextPeriodStart } from './wallet'
import { dublinTodayStr, dublinDayStartMs } from './dublin-time'

// Mirrors the wallets.balance_cents CHECK (>= -1000) and the RPC's
// grace-floor guard (mig 414): −€10.00.
export const TRANSACTIONAL_GRACE_FLOOR_CENTS = -1000

// The three billing meters enforcement covers (shared/plans.js METERS).
export const BILLING_METERS = Object.freeze(['wa_template_send', 'email_send', 'ai_message'])

// ── Pure decision core ──────────────────────────────────────────────

/**
 * May this send class spend one more unit of `meter` given the
 * location's billing state? Pure.
 *
 * @param {object|null} state - from getBillingState(); null = no
 *   active tier pinning → ALWAYS allow (unpinned locations behave
 *   exactly as before enforcement existed).
 * @param {'wa_template_send'|'email_send'|'ai_message'} meter
 * @param {'marketing'|'transactional'|'ai'} sendClass
 * @returns {{ allow: boolean, reason: string }}
 */
export function canSpend(state, meter, sendClass) {
  if (!state) return { allow: true, reason: 'unpinned' }

  const allowance = toCount(state.planVersion?.allowances?.[meter])
  const used = toCount(state.mtdUsage?.[meter])
  if (allowance - used > 0) return { allow: true, reason: 'within_allowance' }

  const balance = Math.trunc(Number(state.wallet?.balance_cents) || 0)

  if (sendClass === 'transactional') {
    if (balance > TRANSACTIONAL_GRACE_FLOOR_CENTS) {
      return { allow: true, reason: balance > 0 ? 'wallet_funded' : 'grace_floor' }
    }
    // At/below the −€10 floor: STILL allow (fail-open — never let
    // billing kill a booking confirmation) but tell the caller to log.
    return { allow: true, reason: 'grace_exhausted_fail_open' }
  }

  // marketing + ai need a positively funded wallet once the allowance
  // is gone (the 'finish the in-flight turn' part of the AI semantics
  // is the caller's job — this check runs at turn-start).
  if (balance > 0) return { allow: true, reason: 'wallet_funded' }
  return { allow: false, reason: 'wallet_empty' }
}

function toCount(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Pure pricing for the daily overage draw poster. unitRates =
 * plan_versions.unit_rates_cents (keys per shared/plans.js
 * UNIT_RATE_KEYS). email is prorated per email off the per-1k rate
 * with the TOTAL rounded UP to the cent; ai is per message; wa is per
 * template send at the caller-selected rate key (see the header's
 * marketing/utility split note). Zero/negative/missing rates price to
 * 0 — fail open, never invent charges.
 *
 * @returns {number} integer cents
 */
export function priceOverageCents(meter, units, unitRates, { waRateKey = 'wa_marketing' } = {}) {
  const n = Math.max(0, Math.floor(Number(units) || 0))
  if (n === 0) return 0
  const rates = unitRates || {}
  if (meter === 'email_send') {
    const per1k = Number(rates.email_per_1k)
    if (!Number.isFinite(per1k) || per1k <= 0) return 0
    return Math.ceil((n * per1k) / 1000)
  }
  if (meter === 'ai_message') {
    const per = Number(rates.ai_message)
    if (!Number.isFinite(per) || per <= 0) return 0
    return n * per
  }
  if (meter === 'wa_template_send') {
    const per = Number(rates[waRateKey])
    if (!Number.isFinite(per) || per <= 0) return 0
    return n * per
  }
  return 0
}

/**
 * The idempotent draw delta: cumulative MTD overage cost minus cents
 * already drawn for this meter this period, floored at 0 (an earlier
 * over-draw is never "refunded" by a negative draw — corrections are
 * operator 'adjustment' entries). Pure.
 */
export function drawDeltaCents(cumulativeCostCents, alreadyDrawnCents) {
  const cum = Math.max(0, Math.floor(Number(cumulativeCostCents) || 0))
  const drawn = Math.max(0, Math.floor(Number(alreadyDrawnCents) || 0))
  return Math.max(0, cum - drawn)
}

/**
 * Clamp a draw so the balance never lands below the grace floor.
 * Returns the cents actually drawable (≥ 0 — landing the balance
 * exactly at the floor when clamped) and the unbilled shortfall (the
 * deferred invoice leg's problem — callers log it loudly). Pure.
 */
export function clampDrawToFloor(deltaCents, balanceCents, floorCents = TRANSACTIONAL_GRACE_FLOOR_CENTS) {
  const delta = Math.max(0, Math.floor(Number(deltaCents) || 0))
  const balance = Math.trunc(Number(balanceCents) || 0)
  const drawable = Math.max(0, Math.min(delta, balance - floorCents))
  return { drawable, shortfall: delta - drawable }
}

/** True when a wallet_apply rejection is the RPC's grace-floor guard. */
export function isGraceFloorError(err) {
  return /grace floor breached/i.test(String(err?.message || err || ''))
}

/**
 * Pure: the Dublin billing-month window containing `anchorDateStr`
 * (YYYY-MM-DD). monthStart/monthNext are calendar dates for
 * usage_rollups_daily.day filters; startIso/endIso are the UTC
 * instants of Dublin local midnight on those dates for
 * usage_events.occurred_at filters (BST-safe via dublinDayStartMs).
 */
export function billingMonthWindow(anchorDateStr) {
  const monthStart = currentPeriodStart(anchorDateStr)
  const monthNext = nextPeriodStart(anchorDateStr)
  return {
    monthStart,
    monthNext,
    startIso: new Date(dublinDayStartMs(monthStart)).toISOString(),
    endIso: new Date(dublinDayStartMs(monthNext)).toISOString(),
  }
}

// ── IO: month-to-date sums ──────────────────────────────────────────

/**
 * MTD rollup usage for the wa_template_send + email_send meters.
 * ≤ 2 meters × 31 days = ≤ 62 rows — far under the PostgREST 1k cap.
 */
export async function sumRollupUsage(db, locationId, window) {
  const { data, error } = await db
    .from('usage_rollups_daily')
    .select('meter, quantity')
    .eq('location_id', locationId)
    .in('meter', ['wa_template_send', 'email_send'])
    .gte('day', window.monthStart)
    .lt('day', window.monthNext)
  if (error) throw new Error(`sumRollupUsage: ${error.message}`)
  const sums = { wa_template_send: 0, email_send: 0 }
  for (const row of data || []) {
    if (row.meter in sums) sums[row.meter] += Number(row.quantity) || 0
  }
  return sums
}

/**
 * MTD ai_message count: allowance-eligible usage_events rows (the
 * shared/plans.js derivation — see the header caveat). Single-table
 * head:true count, so the embedded-count PostgREST bug doesn't apply.
 */
export async function countAiMessages(db, locationId, window) {
  const { count, error } = await db
    .from('usage_events')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .eq('meter', 'anthropic_tokens')
    .neq('source', 'assistant_chat')
    .gte('occurred_at', window.startIso)
    .lt('occurred_at', window.endIso)
  if (error) throw new Error(`countAiMessages: ${error.message}`)
  return count || 0
}

/**
 * Cents already drawn per meter this billing period (positive
 * numbers). Draws are one-per-meter-per-day, so ≤ ~93 rows/month.
 */
export async function sumDrawnByMeter(db, locationId, periodStart) {
  const { data, error } = await db
    .from('wallet_transactions')
    .select('meter, amount_cents')
    .eq('location_id', locationId)
    .eq('kind', 'draw')
    .eq('period', periodStart)
  if (error) throw new Error(`sumDrawnByMeter: ${error.message}`)
  const sums = {}
  for (const row of data || []) {
    if (!row.meter) continue
    sums[row.meter] = (sums[row.meter] || 0) + Math.abs(Number(row.amount_cents) || 0)
  }
  return sums
}

// ── getBillingState + fail-open check ───────────────────────────────

// Small state cache: enforcement checks can sit on hot send paths
// (blast preflights, Mia turn-start) and everything they read changes
// on cron cadence, not per-send. 30s TTL keeps a burst of checks to
// one query set per location; null (unpinned — today's universal
// case) is cached too so the bypass costs one location_plans read per
// TTL window at most.
const STATE_CACHE_TTL_MS = 30_000
const stateCache = new Map()

/** Test hook — clear the module-level billing-state cache. */
export function clearBillingStateCache() {
  stateCache.clear()
}

/**
 * The location's live billing state, or null when it has no ACTIVE
 * tier pinning (callers treat null as "bypass everything").
 *
 * THROWS on infrastructure errors — send-path callers go through
 * checkSpend() (never throws, fails open); the draw cron does its own
 * per-location try/catch.
 *
 * @param {object} db - service-role client
 * @param {string} locationId
 * @returns {Promise<{
 *   planVersion: { allowances: object, unit_rates_cents: object },
 *   wallet: { balance_cents: number },
 *   mtdUsage: { wa_template_send: number, email_send: number, ai_message: number },
 *   mtdDrawnByMeter: object,
 *   periodStart: string,
 * }|null>}
 */
export async function getBillingState(db, locationId) {
  if (!locationId) return null

  const cached = stateCache.get(locationId)
  if (cached && Date.now() - cached.at < STATE_CACHE_TTL_MS) return cached.state

  const plan = await getLocationPlan(db, locationId)
  if (!plan) {
    stateCache.set(locationId, { at: Date.now(), state: null })
    return null
  }

  const window = billingMonthWindow(dublinTodayStr())
  const [wallet, rollups, aiCount, drawn] = await Promise.all([
    getWallet(db, locationId),
    sumRollupUsage(db, locationId, window),
    countAiMessages(db, locationId, window),
    sumDrawnByMeter(db, locationId, window.monthStart),
  ])

  const state = {
    planVersion: {
      allowances: plan.resolved.allowances,
      unit_rates_cents: plan.resolved.unitRatesCents,
    },
    wallet: { balance_cents: wallet?.balance_cents ?? 0 },
    mtdUsage: {
      wa_template_send: rollups.wa_template_send,
      email_send: rollups.email_send,
      ai_message: aiCount,
    },
    mtdDrawnByMeter: drawn,
    periodStart: window.monthStart,
  }
  stateCache.set(locationId, { at: Date.now(), state })
  return state
}

/**
 * The send-path entry point: getBillingState + canSpend with the
 * usage-caps.js fail-open posture baked in. NEVER throws; any error
 * answers allow:true so a billing bug can never block a real send.
 *
 * @returns {Promise<{ allow: boolean, reason: string }>}
 */
export async function checkSpend(db, locationId, meter, sendClass) {
  try {
    const state = await getBillingState(db, locationId)
    return canSpend(state, meter, sendClass)
  } catch (e) {
    console.error(`[wallet-enforcement] check failed open (${meter}/${sendClass}):`, e?.message || e)
    return { allow: true, reason: 'error_fail_open' }
  }
}

/**
 * Transactional-path observability: never blocks, never throws, only
 * logs. Loud error log at/below the grace floor (the send still goes
 * out — fail-open by spec — but ops must see that the location is
 * sending unbilled), softer warn while riding the grace band.
 * Fire-and-forget: the returned promise never rejects.
 */
export async function logTransactionalWalletState(db, locationId, meter) {
  try {
    const result = await checkSpend(db, locationId, meter, 'transactional')
    if (result.reason === 'grace_exhausted_fail_open') {
      console.error(
        `[wallet-enforcement] location ${locationId} is AT/BELOW the -€10 grace floor with the ${meter} ` +
        'allowance exhausted — transactional send proceeding FAIL-OPEN (unbilled; deferred invoice leg). Top up the wallet.'
      )
    } else if (result.reason === 'grace_floor') {
      console.warn(
        `[wallet-enforcement] location ${locationId} is spending ${meter} against the -€10 transactional ` +
        'grace floor (allowance exhausted, wallet empty). Top up the wallet.'
      )
    }
    return result
  } catch {
    // checkSpend never throws; belt-and-braces so callers can truly
    // fire-and-forget this promise.
    return { allow: true, reason: 'error_fail_open' }
  }
}
