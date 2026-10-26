// REVPAY.3 — the backstop for a lost or deferred Revolut webhook.
//
// Before this, a Revolut payment whose webhook never landed (a delivery lost,
// a deferral the provider never redelivered) was recovered only if the buyer
// kept the status page open. /api/cron/revolut-reconcile (every 15 minutes)
// runs runRevolutReconcile(): it lists the Revolut-backed payment rows still
// waiting on the provider, asks Revolut for each order's authoritative state
// (getOrder) and applies it through THE SAME helpers the webhooks use, so the
// side effects and their idempotency are identical:
//
//   car_deposit     cars.deposit_status 'terms_accepted' + an order id
//                   → depositUpdateForOrder + applyCarDepositUpdates
//                     (orders ledger, contact event, order_* sequences)
//   race_payment    race_payments 'pending', provider 'revolut'
//                   → markRacePaymentStatus (compare-and-set) +
//                     runRacePaymentCompletedEffects (confirmations or the gap
//                     receipt, Glofox push)
//   class_booking   class_booking_requests payment 'pending', provider 'revolut'
//                   → markClassBookingPaymentStatus + the QStash nudge
//   trial_purchase  trial_purchases payment 'pending', provider 'revolut'
//                   → markTrialPurchasePaymentStatus + the QStash nudge
//   offer_purchase  offer_purchases 'created' (always Revolut)
//                   → markOfferPurchaseState (compare-and-set) +
//                     runOfferPaidSideEffects
//   donation        donations 'awaiting_payment', provider 'revolut'
//                   → markDonationPaymentStatus (compare-and-set) +
//                     runPaidDonationSideEffects
//
// Then, with no provider call, a sweep of PAID Revolut donations whose
// receipt or donor contact link did not land (REVPAY.12; see
// sweepPaidDonations below for the window, cap and observerWon choice).
//
// Rows on another provider (a Stripe Connect race payment or donation, a
// un1t.online trial) are never listed. A row the webhook settles between the
// listing and the apply is re-read first and skipped; where the webhook and
// this cron can still race on the write itself, the cron's write is a
// compare-and-set (cars, offers; race payments and donations already were),
// so only one of them runs the side effects. The class-booking and trial
// marks are plain writes, but a double release is harmless: the nudge carries
// the webhook's own QStash dedup id and the processor claims a row once.
//
// WINDOW. A row is a candidate from 10 minutes old (the webhook normally
// lands in seconds and the buyer's status page re-checks while it is open;
// starting later than that keeps the cron off a checkout in progress) to
// 7 days old (a Revolut card order settles in minutes; a week covers a
// webhook outage over a long weekend plus the time to notice it, and past it
// a pending order is an abandoned checkout).
//
// READS. Every resolver is called with throwOnError (REVPAY.1), so a failed
// read is an error (counted, retried next tick), never "already settled".
//
// BUDGET AND FAIRNESS. At most RECONCILE_BUDGET (50) provider calls a tick.
// Abandoned checkouts stay 'pending' at Revolut for ever, so ordering the
// whole set oldest-first would let the same 50 stuck rows fill every tick
// (CLAUDE.md, DETAILBACKFILL.1: a backfill cursor must advance on every
// attempt). There is no attempted-at column to advance (no DDL here), so the
// cursor is the clock: a row is DUE on a tick by an age-based backoff spread
// by a hash of its id (isDue): every tick while under 2 hours old, one tick
// in 4 (hourly) until a day old, one in 24 (six-hourly) until a week old.
// A row that stays pending therefore leaves the head of the queue on its own,
// and every row is reached within its period unless more than 50 rows are
// due on one tick, which the counts (over_budget) would show. Due rows go
// oldest first.
//
// FAILURES. One row's failure never stops the run: a getOrder failure is a
// skip (provider_failed, retried on a later tick), a throw is counted
// (errors). The run is healthy, and the route stamps its heartbeat, when
// every list was read and the provider answered at least one call it was
// asked (a run with nothing due is healthy). A list that could not be read,
// or a tick where EVERY provider call failed (a revoked key, an outage), is
// not: the backstop did not work, so a fault that lasts past one missed tick
// pages.

import { getOrder as revolutGetOrder } from './revolut'
import { depositUpdateForOrder, applyCarDepositUpdates } from './car-deposit-revolut'
import { resolveRacePaymentByProviderRef, markRacePaymentStatus } from './race-payments'
import { runRacePaymentCompletedEffects } from './race-payment-completed'
import { resolveClassBookingPaymentByRef, markClassBookingPaymentStatus } from './class-booking-payments'
import { resolveTrialPurchaseByRef, markTrialPurchasePaymentStatus } from './trial-purchase-payments'
import { publishQueuePush, CLASS_BOOKINGS_WORKER_PATH, TRIAL_PURCHASES_WORKER_PATH } from './qstash'
import { resolveOfferPurchaseByOrderId, markOfferPurchaseState } from './sale-offers'
import { runOfferPaidSideEffects } from './offer-purchase-paid'
import {
  DONATION_COLS, DONATION_EVENT_COLS, resolveDonationByRef, markDonationPaymentStatus, runPaidDonationSideEffects,
} from './donation-payments'
import { resolveCharitySettings } from './charity-donations'
import { logError, logWarn } from './log'

const LOG_MODULE = 'revolut-reconcile'

export const RECONCILE_MIN_AGE_MS = 10 * 60_000
export const RECONCILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000
export const RECONCILE_BUDGET = 50
/**
 * Wall-clock limit for the row loop. The route's maxDuration is 300 s; a
 * Revolut outage makes every getOrder wait out its timeout, and 50 of those
 * would outlast the function, which Vercel kills mid-row. Rows not reached
 * are counted as out_of_time and come back on a later tick.
 */
export const RECONCILE_RUN_DEADLINE_MS = 240_000
/** The cron's own getOrder: one retry and a shorter timeout than a webhook's. */
const cronGetOrder = (ref) => revolutGetOrder(ref, { timeoutMs: 8_000, retries: 1 })
/** The cron's period: the unit of the backoff. */
export const RECONCILE_TICK_MS = 15 * 60_000
const HOURLY_FROM_MS = 2 * 60 * 60_000
const SIX_HOURLY_FROM_MS = 24 * 60 * 60_000
/** Rows per page of a candidate list (under the 1,000-row select cap). */
const PAGE = 500

export const DOMAINS = ['car_deposit', 'race_payment', 'class_booking', 'trial_purchase', 'offer_purchase', 'donation']

/** Revolut order states that end a payment; anything else is still in flight. */
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

/** FNV-1a over a string: a stable small hash to spread rows across ticks. */
export function stableHash(str) {
  let h = 0x811c9dc5
  const s = String(str || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Pure: is this row due a provider check on the tick that contains `nowMs`?
 * Outside the 10 min .. 7 day window never; under 2 h every tick; under a day
 * one tick in 4; else one tick in 24 (offset by the id's hash, so the stuck
 * rows of one age band spread over the ticks instead of arriving together).
 */
export function isDue({ id, createdAtMs, nowMs }) {
  return isDueInWindow({ id, createdAtMs, nowMs, minAgeMs: RECONCILE_MIN_AGE_MS, maxAgeMs: RECONCILE_MAX_AGE_MS })
}

/** isDue's backoff over any [minAgeMs, maxAgeMs] window (the receipt sweep's is 15 min .. 7 days). */
export function isDueInWindow({ id, createdAtMs, nowMs, minAgeMs, maxAgeMs }) {
  const age = nowMs - createdAtMs
  if (!Number.isFinite(age) || age < minAgeMs || age > maxAgeMs) return false
  const period = age < HOURLY_FROM_MS ? 1 : age < SIX_HOURLY_FROM_MS ? 4 : 24
  const tick = Math.floor(nowMs / RECONCILE_TICK_MS)
  return (tick + stableHash(id)) % period === 0
}

/**
 * Pure: pick this tick's batch from every candidate. Due rows only, oldest
 * first (id breaks ties), at most `budget`.
 * @param {{ domain: string, id: string, ref: string, createdAt: string }[]} candidates
 * @returns {{ batch: object[], due: number, overBudget: number }}
 */
export function selectBatch(candidates, nowMs, budget = RECONCILE_BUDGET) {
  const due = candidates
    .map((c) => ({ ...c, createdAtMs: Date.parse(c.createdAt) }))
    .filter((c) => c.ref && isDue({ id: c.id, createdAtMs: c.createdAtMs, nowMs }))
    .sort((a, b) => (a.createdAtMs - b.createdAtMs) || String(a.id).localeCompare(String(b.id)))
  const batch = due.slice(0, Math.max(0, budget))
  return { batch, due: due.length, overBudget: due.length - batch.length }
}

/** Page a list query to the end; `page(from, to)` returns the query for one page. */
async function paginate(page) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw error
    const rows = Array.isArray(data) ? data : []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

// ── Candidate lists: the window is applied in SQL, the backoff in isDue ─────

const LISTS = {
  car_deposit: async (db, fromIso, toIso) => (await paginate((a, b) => db.from('cars')
    .select('id, deposit_revolut_order_id, deposit_terms_accepted_at')
    .eq('deposit_status', 'terms_accepted')
    .not('deposit_revolut_order_id', 'is', null)
    .gte('deposit_terms_accepted_at', fromIso)
    .lte('deposit_terms_accepted_at', toIso)
    .order('deposit_terms_accepted_at', { ascending: true })
    .order('id', { ascending: true })
    .range(a, b)))
    .map((r) => ({ id: r.id, ref: r.deposit_revolut_order_id, createdAt: r.deposit_terms_accepted_at })),

  race_payment: async (db, fromIso, toIso) => (await paginate((a, b) => db.from('race_payments')
    .select('id, payment_provider_ref, created_at')
    .eq('status', 'pending')
    .eq('payment_provider', 'revolut')
    .not('payment_provider_ref', 'is', null)
    .gte('created_at', fromIso)
    .lte('created_at', toIso)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(a, b)))
    .map((r) => ({ id: r.id, ref: r.payment_provider_ref, createdAt: r.created_at })),

  class_booking: async (db, fromIso, toIso) => (await paginate((a, b) => db.from('class_booking_requests')
    .select('id, payment_provider_ref, created_at')
    .eq('payment_status', 'pending')
    .eq('payment_provider', 'revolut')
    .not('payment_provider_ref', 'is', null)
    .gte('created_at', fromIso)
    .lte('created_at', toIso)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(a, b)))
    .map((r) => ({ id: r.id, ref: r.payment_provider_ref, createdAt: r.created_at })),

  trial_purchase: async (db, fromIso, toIso) => (await paginate((a, b) => db.from('trial_purchases')
    .select('id, payment_provider_ref, created_at')
    .eq('payment_status', 'pending')
    .eq('payment_provider', 'revolut')
    .not('payment_provider_ref', 'is', null)
    .gte('created_at', fromIso)
    .lte('created_at', toIso)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(a, b)))
    .map((r) => ({ id: r.id, ref: r.payment_provider_ref, createdAt: r.created_at })),

  // offer_purchases.revolut_order_id is NOT NULL (mig 503): always Revolut.
  offer_purchase: async (db, fromIso, toIso) => (await paginate((a, b) => db.from('offer_purchases')
    .select('id, revolut_order_id, created_at')
    .eq('state', 'created')
    .gte('created_at', fromIso)
    .lte('created_at', toIso)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(a, b)))
    .map((r) => ({ id: r.id, ref: r.revolut_order_id, createdAt: r.created_at })),

  donation: async (db, fromIso, toIso) => (await paginate((a, b) => db.from('donations')
    .select('id, payment_provider_ref, created_at')
    .eq('status', 'awaiting_payment')
    .eq('payment_provider', 'revolut')
    .not('payment_provider_ref', 'is', null)
    .gte('created_at', fromIso)
    .lte('created_at', toIso)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(a, b)))
    .map((r) => ({ id: r.id, ref: r.payment_provider_ref, createdAt: r.created_at })),
}

// ── Apply: one row, through the webhook's own helpers ──────────────────────
//
// Each returns { outcome, state? } where outcome is one of
//   settled          THIS call moved the row to a terminal state (side effects ran)
//   still_pending    Revolut says the order is still in flight
//   already_settled  the row left the pending set since it was listed
//   not_applied      Revolut is terminal but the write was not this caller's
//                    (another path won the compare-and-set, or the write failed:
//                    the helper logs that, and the row is retried next tick)
//   provider_failed  getOrder threw or returned nothing (retried next tick)

const PROVIDER_FAILED = Object.freeze({ outcome: 'provider_failed' })
const ALREADY_SETTLED = Object.freeze({ outcome: 'already_settled' })

async function fetchOrder(getOrder, domain, ref) {
  try {
    const order = await getOrder(ref)
    return order || null
  } catch (e) {
    // A RevolutError carries only the HTTP status and Revolut's message; no
    // order id or buyer field is logged.
    logWarn(LOG_MODULE, 'getOrder failed; row skipped this tick', { domain, status: e?.status ?? null, errClass: e?.name ?? null })
    return null
  }
}

const lower = (s) => String(s || '').toLowerCase()
const minorAmount = (order) => (Number.isFinite(order?.amount) ? order.amount : null)
const transientOr = (state, terminalOutcome) => (TERMINAL.has(state) ? { outcome: terminalOutcome, state } : { outcome: 'still_pending', state })

// The same columns the webhook reads (src/lib/car-deposit-revolut.js); kept
// here as a same-file literal so check:select-columns reads it.
const CAR_COLS = `
      id, location_id, deposit_token, deposit_status, deposit_paid_at,
      deposit_amount, deposit_paid_amount,
      deposit_revolut_order_id, deposit_link_sent_at,
      buyer_email, buyer_phone, buyer_name, make, model, irish_reg,
      locations ( id, name )
    `

const APPLY = {
  async car_deposit({ db, row, getOrder }) {
    const { data: car, error } = await db.from('cars').select(CAR_COLS).eq('id', row.id).maybeSingle()
    if (error) throw error
    if (!car || car.deposit_status !== 'terms_accepted' || car.deposit_revolut_order_id !== row.ref) return ALREADY_SETTLED
    const order = await fetchOrder(getOrder, 'car_deposit', row.ref)
    if (!order) return PROVIDER_FAILED
    const { state, updates } = depositUpdateForOrder({ order, car })
    if (!updates) return { outcome: 'still_pending', state }
    const { written } = await applyCarDepositUpdates({ db, car, order, state, updates, guardStatus: true })
    return { outcome: written ? 'settled' : 'not_applied', state }
  },

  async race_payment({ db, row, getOrder }) {
    const payment = await resolveRacePaymentByProviderRef(db, row.ref, { throwOnError: true })
    if (!payment || payment.id !== row.id || payment.status !== 'pending' || payment.payment_provider !== 'revolut') return ALREADY_SETTLED
    const order = await fetchOrder(getOrder, 'race_payment', row.ref)
    if (!order) return PROVIDER_FAILED
    const state = lower(order.state)
    const result = await markRacePaymentStatus({ db, payment, revolutState: state, revolutAmount: minorAmount(order) })
    // REVPAY.1: the status write failed (the helper logged it). Counted as an
    // error; the row is still pending, so a later tick retries it.
    if (result?.error) throw result.error
    if (!result?.applied) return transientOr(state, 'not_applied')
    if (result.applied.status === 'completed') {
      const { glofoxPush } = await runRacePaymentCompletedEffects({ db, payment, applied: result.applied })
      // The webhook defers the push to after(); a cron runs it inline, so the
      // function is not frozen half-way through a team. It never rejects.
      if (glofoxPush) await glofoxPush()
    }
    return { outcome: 'settled', state }
  },

  async class_booking({ db, row, getOrder, publish }) {
    const request = await resolveClassBookingPaymentByRef(db, row.ref, { throwOnError: true })
    if (!request || request.id !== row.id || request.payment_status !== 'pending') return ALREADY_SETTLED
    const order = await fetchOrder(getOrder, 'class_booking', row.ref)
    if (!order) return PROVIDER_FAILED
    const state = lower(order.state)
    const { released, error: markErr } = await markClassBookingPaymentStatus({ db, request, providerState: state, providerAmount: minorAmount(order) })
    if (markErr) throw markErr
    if (released) {
      // The webhook's nudge, with its dedup id. The queue row is the guarantee.
      try { await publish({ path: CLASS_BOOKINGS_WORKER_PATH, body: { id: request.id }, deduplicationId: `class-booking-${request.id}` }) } catch { /* queue is the guarantee */ }
    }
    return transientOr(state, 'settled')
  },

  async trial_purchase({ db, row, getOrder, publish }) {
    const purchase = await resolveTrialPurchaseByRef(db, row.ref, { throwOnError: true })
    if (!purchase || purchase.id !== row.id || purchase.payment_status !== 'pending' || purchase.payment_provider !== 'revolut') return ALREADY_SETTLED
    const order = await fetchOrder(getOrder, 'trial_purchase', row.ref)
    if (!order) return PROVIDER_FAILED
    const state = lower(order.state)
    const { released } = await markTrialPurchasePaymentStatus({ db, purchase, providerState: state, providerAmount: minorAmount(order) })
    if (released) {
      try { await publish({ path: TRIAL_PURCHASES_WORKER_PATH, body: { id: purchase.id }, deduplicationId: `trial-purchase-${purchase.id}` }) } catch { /* queue is the guarantee */ }
    }
    return transientOr(state, 'settled')
  },

  async offer_purchase({ db, row, getOrder }) {
    const purchase = await resolveOfferPurchaseByOrderId(db, row.ref, { throwOnError: true })
    if (!purchase || purchase.id !== row.id || purchase.state !== 'created') return ALREADY_SETTLED
    const order = await fetchOrder(getOrder, 'offer_purchase', row.ref)
    if (!order) return PROVIDER_FAILED
    const state = lower(order.state)
    const { changed, state: next } = await markOfferPurchaseState({ db, purchase, providerState: state, casOnState: true })
    if (!changed) return transientOr(state, 'not_applied')
    if (next === 'paid') {
      try {
        await runOfferPaidSideEffects(db, purchase)
      } catch (e) {
        logError(LOG_MODULE, 'offer paid side effects failed', { err: e, purchaseId: purchase.id })
      }
    }
    return { outcome: 'settled', state }
  },

  async donation({ db, row, getOrder }) {
    const donation = await resolveDonationByRef(db, row.ref)
    if (!donation || donation.id !== row.id || donation.status !== 'awaiting_payment' || donation.payment_provider !== 'revolut') return ALREADY_SETTLED
    const order = await fetchOrder(getOrder, 'donation', row.ref)
    if (!order) return PROVIDER_FAILED
    const state = lower(order.state)
    if (!TERMINAL.has(state)) return { outcome: 'still_pending', state }
    // The event supplies the match multiplier snapshotted onto a paid row and
    // the side effects' charity settings; without it nothing is written.
    const { data: race, error: raceErr } = await db.from('race_events').select(DONATION_EVENT_COLS).eq('id', donation.race_event_id).maybeSingle()
    if (raceErr || !race) throw raceErr || new Error('donation event row missing')
    const marked = await markDonationPaymentStatus({
      db, donation, providerState: state, providerAmount: minorAmount(order),
      multiplier: resolveCharitySettings(race).match_multiplier,
    })
    if (!marked?.changed) return { outcome: 'not_applied', state }
    // Re-read: the side effects get the row as stored, never a guess.
    const { data: fresh, error: readErr } = await db.from('donations').select(DONATION_COLS).eq('id', donation.id).maybeSingle()
    if (readErr || !fresh) {
      logError(LOG_MODULE, 'donation re-read after mark failed; the status poll or a later observer sends the receipt', { err: readErr, donationId: donation.id })
    } else if (fresh.status === 'paid') {
      try {
        await runPaidDonationSideEffects({ db, donation: fresh, race, ipAddress: null, observerWon: true })
      } catch (e) {
        logError(LOG_MODULE, 'donation paid side effects failed', { err: e, donationId: donation.id })
      }
    }
    return { outcome: 'settled', state }
  },
}

// ── REVPAY.12: paid donations whose receipt or contact step did not land ───
//
// The lists above only see 'awaiting_payment' donations. A donation that is
// 'paid' but whose receipt (or donor contact link) failed was retried only
// when someone observed it again: a webhook redelivery, the donor reopening
// the status page, staff Re-check. This sweep is that later observation.
// It makes no provider call (the row is already paid) and re-runs
// runPaidDonationSideEffects, whose own stamps (receipt_email_sent_at,
// contact_id, each written after its effect) make a step that already landed
// a no-op.
//
// observerWon: FALSE. The sweep did not flip the row, and false is the value
// that can only ever DEFER a receipt, never send one the helper would have
// left to the winning observer: inside the minute after paid_at a false
// observer answers 'deferred'. The sweep's window starts 15 minutes after
// paid_at, so in practice false and true behave the same here (the receipt
// goes iff its stamp is still null); but true would claim this caller won a
// compare-and-set it never ran, and would bypass the single-observer guard
// for any row that ever reached the sweep inside that minute. The remaining
// duplicate risk is the helper's own (no claim before a send that cannot be
// taken back): an observer running at the same instant as the sweep, which
// sendDonationReceipt logs as a DUPLICATE when its stamp loses.
//
// Candidates: status 'paid', provider 'revolut', paid 15 minutes to 7 days
// ago, a donor address present (a donation with no address has nothing to
// deliver and no contact to link, so it is never listed), and the receipt
// stamp or the contact link still missing. A receipt suppressed by consent
// is stamped, so it is never retried. The same age backoff as isDue, on
// paid_at, so a receipt that keeps failing leaves the head of the queue and
// stops at 7 days; at most RECEIPT_SWEEP_BUDGET rows a tick, oldest first.
// Each due row is re-read just before its side effects so the stamps it
// carries are current. A sweep failure (the list, an event read, a row) is a
// count, never an unhealthy run: the provider backstop above is what pages.

export const RECEIPT_SWEEP_MIN_AGE_MS = 15 * 60_000
export const RECEIPT_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60_000
export const RECEIPT_SWEEP_BUDGET = 25

const RECEIPT_SWEEP_LIST_COLS = 'id, paid_at, donor_email'

async function listReceiptSweepCandidates(db, fromIso, toIso) {
  return (await paginate((a, b) => db.from('donations')
    .select(RECEIPT_SWEEP_LIST_COLS)
    .eq('status', 'paid')
    .eq('payment_provider', 'revolut')
    .not('donor_email', 'is', null)
    .neq('donor_email', '')
    .or('receipt_email_sent_at.is.null,contact_id.is.null')
    .gte('paid_at', fromIso)
    .lte('paid_at', toIso)
    .order('paid_at', { ascending: true })
    .order('id', { ascending: true })
    .range(a, b)))
    // A whitespace-only address is no address.
    .filter((r) => String(r.donor_email || '').trim())
    .map((r) => ({ id: r.id, paidAt: r.paid_at }))
}

/**
 * Pure: this tick's receipt-sweep batch. Due rows only (isDueInWindow on
 * paid_at), oldest first, at most `budget`.
 */
export function selectReceiptSweepBatch(candidates, nowMs, budget = RECEIPT_SWEEP_BUDGET) {
  const due = candidates
    .map((c) => ({ ...c, paidAtMs: Date.parse(c.paidAt) }))
    .filter((c) => isDueInWindow({
      id: c.id, createdAtMs: c.paidAtMs, nowMs, minAgeMs: RECEIPT_SWEEP_MIN_AGE_MS, maxAgeMs: RECEIPT_SWEEP_MAX_AGE_MS,
    }))
    .sort((a, b) => (a.paidAtMs - b.paidAtMs) || String(a.id).localeCompare(String(b.id)))
  const batch = due.slice(0, Math.max(0, budget))
  return { batch, due: due.length, overBudget: due.length - batch.length }
}

/**
 * The receipt sweep. Never throws; adds its receipt_* counts to `counts`.
 * `pastDeadline()` is the run's wall-clock check.
 */
async function sweepPaidDonations({ db, nowMs, counts, budget, pastDeadline }) {
  Object.assign(counts, {
    receipt_candidates: 0, receipt_due: 0, receipt_over_budget: 0,
    receipt_retried: 0, receipt_sent: 0, receipt_failed: 0, receipt_contact_linked: 0,
    receipt_skipped: 0, receipt_errors: 0, receipt_out_of_time: 0, receipt_list_failed: false,
  })
  let candidates
  try {
    candidates = await listReceiptSweepCandidates(
      db,
      new Date(nowMs - RECEIPT_SWEEP_MAX_AGE_MS).toISOString(),
      new Date(nowMs - RECEIPT_SWEEP_MIN_AGE_MS).toISOString(),
    )
  } catch (e) {
    counts.receipt_list_failed = true
    logError(LOG_MODULE, 'paid-donation receipt sweep: list unreadable', { code: e?.code ?? null, errClass: e?.name ?? null })
    return
  }
  counts.receipt_candidates = candidates.length
  const { batch, due, overBudget } = selectReceiptSweepBatch(candidates, nowMs, budget)
  counts.receipt_due = due
  counts.receipt_over_budget = overBudget

  const races = new Map()
  for (const [i, c] of batch.entries()) {
    if (pastDeadline()) {
      counts.receipt_out_of_time = batch.length - i
      break
    }
    try {
      const { data: donation, error } = await db.from('donations').select(DONATION_COLS).eq('id', c.id).maybeSingle()
      if (error) throw error
      const needsWork = donation && donation.status === 'paid' && donation.payment_provider === 'revolut'
        && String(donation.donor_email || '').trim() && (!donation.receipt_email_sent_at || !donation.contact_id)
      if (!needsWork) {
        counts.receipt_skipped++
        continue
      }
      let race = races.get(donation.race_event_id)
      if (!race) {
        const { data, error: raceErr } = await db.from('race_events').select(DONATION_EVENT_COLS).eq('id', donation.race_event_id).maybeSingle()
        if (raceErr || !data) throw raceErr || new Error('donation event row missing')
        race = data
        races.set(donation.race_event_id, race)
      }
      counts.receipt_retried++
      const out = await runPaidDonationSideEffects({ db, donation, race, ipAddress: null, observerWon: false })
      if (out?.receipt === 'sent') counts.receipt_sent++
      else if (out?.receipt === 'failed') counts.receipt_failed++
      if (!donation.contact_id && out?.contact === 'linked') counts.receipt_contact_linked++
    } catch (e) {
      counts.receipt_errors++
      logError(LOG_MODULE, 'paid-donation receipt sweep: row failed', { err: e, donationId: c.id })
    }
  }
}

/**
 * One reconcile run. Never throws.
 *
 * @param {object} args
 * @param {object} args.db  service-role client
 * @param {Date}   [args.now]
 * @param {(orderId: string) => Promise<object>} [args.getOrder]  injected in tests
 * @param {Function} [args.publish]  QStash nudge, injected in tests
 * @param {number} [args.budget]
 * @param {number} [args.receiptBudget]  rows the paid-donation receipt sweep may take (REVPAY.12)
 * @returns {Promise<{ healthy: boolean, counts: object }>}
 */
export async function runRevolutReconcile({
  db, now = new Date(), getOrder = cronGetOrder, publish = publishQueuePush, budget = RECONCILE_BUDGET,
  runDeadlineMs = RECONCILE_RUN_DEADLINE_MS, clock = Date.now, receiptBudget = RECEIPT_SWEEP_BUDGET,
}) {
  const startedMs = clock()
  const nowMs = now.getTime()
  const fromIso = new Date(nowMs - RECONCILE_MAX_AGE_MS).toISOString()
  const toIso = new Date(nowMs - RECONCILE_MIN_AGE_MS).toISOString()

  const counts = {
    candidates: 0, due: 0, checked: 0, over_budget: 0,
    settled: 0, still_pending: 0, already_settled: 0, not_applied: 0, provider_failed: 0, errors: 0,
    out_of_time: 0,
    list_failed: [],
    by_domain: {},
  }

  const candidates = []
  for (const domain of DOMAINS) {
    try {
      const rows = await LISTS[domain](db, fromIso, toIso)
      for (const r of rows) candidates.push({ domain, ...r })
    } catch (e) {
      counts.list_failed.push(domain)
      logError(LOG_MODULE, 'candidate list unreadable', { domain, code: e?.code ?? null, errClass: e?.name ?? null })
    }
  }
  counts.candidates = candidates.length

  const { batch, due, overBudget } = selectBatch(candidates, nowMs, budget)
  counts.due = due
  counts.over_budget = overBudget

  // Every provider call this run made, and how many failed, for the health
  // rule below. A 4xx about ONE order (a 404 for an order this merchant
  // account does not hold) is Revolut answering, not Revolut failing: it is
  // still a skipped row, but it must not page on a tick where that row is the
  // only one due. 401/403 (the key) and 429 (throttled) do count.
  const calls = { made: 0, failed: 0 }
  const countedGetOrder = async (ref) => {
    calls.made++
    try {
      const order = await getOrder(ref)
      if (!order) calls.failed++
      return order
    } catch (e) {
      const st = Number(e?.status)
      const answeredAboutTheOrder = st >= 400 && st < 500 && st !== 401 && st !== 403 && st !== 429
      if (!answeredAboutTheOrder) calls.failed++
      throw e
    }
  }

  for (const [i, row] of batch.entries()) {
    if (clock() - startedMs > runDeadlineMs) {
      counts.out_of_time = batch.length - i
      logWarn(LOG_MODULE, 'run deadline reached; remaining rows wait for a later tick', { out_of_time: counts.out_of_time })
      break
    }
    counts.checked++
    const d = (counts.by_domain[row.domain] ||= { checked: 0, settled: 0 })
    d.checked++
    try {
      const { outcome } = await APPLY[row.domain]({ db, row, getOrder: countedGetOrder, publish })
      counts[outcome] = (counts[outcome] || 0) + 1
      if (outcome === 'settled') d.settled++
    } catch (e) {
      counts.errors++
      logError(LOG_MODULE, 'row reconcile failed', { domain: row.domain, err: e })
    }
  }

  counts.provider_calls = calls.made

  // REVPAY.12 — paid donations whose receipt or contact link did not land.
  // Counts only: it never makes the run unhealthy.
  try {
    await sweepPaidDonations({
      db, nowMs, counts, budget: receiptBudget, pastDeadline: () => clock() - startedMs > runDeadlineMs,
    })
  } catch (e) {
    counts.receipt_errors = (counts.receipt_errors || 0) + 1
    logError(LOG_MODULE, 'paid-donation receipt sweep threw', { err: e })
  }

  const everyProviderCallFailed = calls.made > 0 && calls.failed === calls.made
  const healthy = counts.list_failed.length === 0 && !everyProviderCallFailed
  return { healthy, counts }
}
