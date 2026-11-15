// HATCHTRACK.1 — "Continue to payment" for a Hatch Street (un1t.online) trial.
//
// A Hatch buyer who backs out of un1t.online's hosted checkout, or comes back
// later from the follow-up email, used to start again: retype everything and
// get a second trial_purchases row. This hands the SAME row back to payment.
//
// The caller holds the purchase id (its own browser's state, `?purchase=` on
// its return, or the link in the email sent to the buyer's own address): the
// id is the capability, as it is for the status route. Nothing here reads or
// returns the buyer's name, email or phone.
//
// Which checkout:
//   - the row's newest checkout on the write ledger, when it is younger than
//     UN1T_CHECKOUT_REUSE_MS (un1t.online's checkout is a Stripe page, which
//     stays open after Back and for at least 30 minutes): no write at all;
//   - otherwise a FRESH checkout for the same row and the same un1t.online
//     account, through createCheckoutLink (the one transport, judged on the
//     body, ledgered, budgeted). Its key is `trial_purchase:<id>:r<n>`, n the
//     number of checkouts already on the ledger for the row, so each attempt
//     is its own ledger row and the row's attempts are countable there. An
//     attempt still open under its key is resumed under that key, never
//     doubled.
// Never a charge, never a grant, never a new account, never a new row.
//
// NEVER A PAY BUTTON FOR SOMEONE WHO HAS PAID. un1t.online takes the money and
// the CRM learns of it up to ~17 minutes later, and a second payment could
// settle no row (one payment settles one row), so it would need a refund by
// hand. Before any checkout is handed back or made, un1tRetryGate must pass:
//   1. the row still awaits payment (un1tTrialRetryable);
//   2. the row's newest finished checkout was minted with the `paid=1`
//      success return (its ledger key, isPaidAwareCheckoutKey): a return from
//      an older checkout cannot be told from a paid one;
//   3. the mirror (un1t_transactions) holds no paid transaction of this
//      un1t.online user at this studio since the row was made, for the row's
//      product or with no product (the settle sweep's own rule);
//   4. (the POST only) un1t.online's LIVE credits ledger for the user, one
//      budgeted GET, plus the mirror's live subscriptions (fetchLiveEntitlement):
//      a balance of one or more, unlimited, or a live subscription means the
//      account already holds something, so the buyer is not sent to pay.
// Any of those reads failing is "unknown", and unknown is never "unpaid": no
// checkout, and the page shows the being-confirmed screen.
//
// It never changes the row's status. An earlier checkout may still be paid,
// so a throttle, a refusal or an unclear answer here must not close the row
// (startUn1tTrialCheckout, which owns a row nobody has been sent to pay yet,
// does). The settle sweep keeps a row open while a checkout made for it is
// inside its window (trial-purchase-un1t-settle.js), so a row given a fresh
// checkout is not expired under the buyer.
import { createCheckoutLink } from '@/lib/un1t-online-write-ops'
import { Un1tWriteRefused, Un1tWriteUnknown } from '@/lib/un1t-online-write'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { trialPurchasePublicState } from '@/lib/paid-trial'
import { un1tTrialRetryable, UN1T_CHECKOUT_REUSE_MS } from '@/lib/trial-checkout-window'
import { UN1T_TRIAL_ORIGIN, un1tTrialReturnUrls, un1tTrialCheckoutKey, isPaidAwareCheckoutKey } from '@/lib/trial-purchase-un1t-checkout'
import { fetchLiveEntitlement } from '@/lib/agent/un1t-member-read'
import { logWarn, logError } from '@/lib/log'

const LOG = 'trialbuy-resume'
const ROW_COLS = 'id, location_id, status, payment_status, payment_provider, un1t_user_id, un1t_product_id, created_at'
const LEDGER_COLS = 'id, stage, checkout_url, idempotency_key, created_at'
const OPEN_STAGES = new Set(['sent', 'unknown'])

const unavailable = (code) => ({ kind: 'unavailable', code })
const TX_COLS = 'un1t_id, product_id, type, amount_cents, remote_created_at'

/**
 * May this Hatch row be given a checkout? Steps 1 to 3 above, and step 4 when
 * `live` is true. Never throws.
 * @returns {Promise<{ ok: true, ledger: object[] }
 *   | { ok: false, reason: 'not_retryable'|'legacy_checkout'|'paid_in_mirror'|'holds_credits'|'read_failed', code?: string }>}
 */
export async function un1tRetryGate(db, row, { nowMs = Date.now(), live = false } = {}, deps = {}) {
  const { liveEntitlement = fetchLiveEntitlement } = deps
  if (!un1tTrialRetryable(row, nowMs)) return { ok: false, reason: 'not_retryable' }
  const locationId = row.location_id
  const ids = { purchaseId: row.id, locationId }

  // The row's checkouts so far (newest first), for this account and product only.
  let ledger
  try {
    const { data, error } = await db.from('un1t_write_events').select(LEDGER_COLS)
      .eq('location_id', locationId).eq('op', 'checkout').eq('origin_ref', row.id)
      .eq('un1t_user_id', String(row.un1t_user_id)).eq('target', row.un1t_product_id)
      .order('created_at', { ascending: false }).range(0, 99)
    if (error) throw Object.assign(new Error('ledger unreadable'), { code: error.code ?? null })
    ledger = Array.isArray(data) ? data : []
  } catch (err) {
    logError(LOG, 'checkout ledger unreadable; no checkout', { ...ids, code: err?.code ?? null, errClass: err?.name })
    return { ok: false, reason: 'read_failed', code: 'ledger_unreadable' }
  }
  const newestDone = ledger.find((e) => e?.stage === 'done') || null
  if (newestDone && !isPaidAwareCheckoutKey(newestDone.idempotency_key)) return { ok: false, reason: 'legacy_checkout' }

  // A payment the mirror already holds (the settle sweep's matching rule).
  try {
    const { data, error } = await db.from('un1t_transactions').select(TX_COLS)
      .eq('location_id', locationId).eq('un1t_user_id', String(row.un1t_user_id))
      .gte('remote_created_at', row.created_at)
      .order('remote_created_at', { ascending: false }).range(0, 99)
    if (error) throw Object.assign(new Error('transactions unreadable'), { code: error.code ?? null })
    const paid = (Array.isArray(data) ? data : []).some((t) => Number(t?.amount_cents) > 0 && t?.type !== 'sub_renewal'
      && (t?.product_id == null || t.product_id === row.un1t_product_id))
    if (paid) return { ok: false, reason: 'paid_in_mirror' }
  } catch (err) {
    logError(LOG, 'un1t transactions unreadable; no checkout', { ...ids, code: err?.code ?? null, errClass: err?.name })
    return { ok: false, reason: 'read_failed', code: 'transactions_unreadable' }
  }

  if (live) {
    let ent
    try {
      ent = await liveEntitlement(db, { locationId, un1tUserId: String(row.un1t_user_id) })
    } catch (err) {
      logWarn(LOG, 'live entitlement threw; no checkout', { ...ids, errClass: err?.name })
      return { ok: false, reason: 'read_failed', code: 'entitlement_unreadable' }
    }
    if (!ent?.ok) {
      logWarn(LOG, 'live entitlement unread; no checkout', { ...ids, code: ent?.reason ?? null })
      return { ok: false, reason: 'read_failed', code: `entitlement_${ent?.reason || 'unreadable'}` }
    }
    const holds = ent.unlimited === true || (typeof ent.balance === 'number' && ent.balance >= 1)
      || (Array.isArray(ent.liveSubscriptionIds) && ent.liveSubscriptionIds.length > 0)
    if (holds) return { ok: false, reason: 'holds_credits' }
  }
  return { ok: true, ledger }
}

/**
 * @param {object} db service-role client
 * @param {{ purchaseId: string, returnPath?: string, now?: () => number }} args
 *   returnPath: already allowlisted by the caller (trial-return-path.js)
 * @returns {Promise<
 *   { kind: 'redirect', checkoutUrl: string, reused: boolean, attempt: number }
 *   | { kind: 'not_found' }
 *   | { kind: 'not_resumable', state: string }
 *   | { kind: 'confirming', reason: 'legacy_checkout'|'paid_in_mirror'|'holds_credits' }  (paid, or cannot be told from paid)
 *   | { kind: 'confirming', reason: 'read_failed', retryLater: true }  (could not look: unknown is not unpaid)
 *   | { kind: 'unavailable', code: string }>} never throws
 */
export async function resumeUn1tTrialCheckout(db, { purchaseId, returnPath = '/trial', now = () => Date.now() } = {}, deps = {}) {
  const { createLink = createCheckoutLink, liveEntitlement } = deps
  const nowMs = now()

  let row
  try {
    // Pinned by the primary key: 0 rows is "no such purchase".
    const { data, error } = await db.from('trial_purchases').select(ROW_COLS).eq('id', purchaseId).maybeSingle()
    if (error) throw Object.assign(new Error('row unreadable'), { code: error.code ?? null })
    row = data
  } catch (err) {
    logError(LOG, 'purchase unreadable; no checkout', { purchaseId, code: err?.code ?? null, errClass: err?.name })
    return unavailable('row_unreadable')
  }
  if (!row) return { kind: 'not_found' }
  if (!un1tTrialRetryable(row, nowMs)) return { kind: 'not_resumable', state: trialPurchasePublicState(row) }
  const locationId = row.location_id
  const ids = { purchaseId, locationId }

  // Paid already, or impossible to tell: never a checkout (see the header).
  const gate = await un1tRetryGate(db, row, { nowMs, live: true }, liveEntitlement ? { liveEntitlement } : {})
  if (!gate.ok) {
    if (gate.reason === 'read_failed') return { kind: 'confirming', reason: 'read_failed', retryLater: true }
    logWarn(LOG, 'no checkout: the purchase may already be paid', { ...ids, code: gate.reason })
    return { kind: 'confirming', reason: gate.reason }
  }
  const { ledger } = gate

  const newest = ledger[0] || null
  if (newest?.stage === 'done' && typeof newest.checkout_url === 'string' && newest.checkout_url) {
    const age = nowMs - Date.parse(newest.created_at || '')
    if (Number.isFinite(age) && age >= 0 && age < UN1T_CHECKOUT_REUSE_MS) {
      return { kind: 'redirect', checkoutUrl: newest.checkout_url, reused: true, attempt: ledger.length }
    }
  }

  // A fresh checkout for the same row. An attempt still open keeps its key.
  const idempotencyKey = newest && OPEN_STAGES.has(newest.stage) && newest.idempotency_key
    ? newest.idempotency_key
    : un1tTrialCheckoutKey(purchaseId, ledger.length)
  let checkout
  try {
    const base = await resolveCustomerBaseUrl(db, locationId)
    const { successUrl, cancelUrl } = un1tTrialReturnUrls(base, returnPath, purchaseId)
    checkout = await createLink(db, {
      locationId, userId: String(row.un1t_user_id), productId: row.un1t_product_id,
      successUrl, cancelUrl, idempotencyKey,
      origin: UN1T_TRIAL_ORIGIN, originRef: purchaseId, actor: null,
    })
  } catch (err) {
    if (err instanceof Un1tSettingsReadError) return unavailable(err.code || 'un1t_settings_unreadable')
    if (err instanceof Un1tWriteRefused) {
      // A throttle or a budget answer: try again in a moment. Anything else
      // (the product is gone, the studio's writes are off) will not change on
      // a second press: the page sends the buyer back to the form.
      if (err.result?.retryable) return unavailable(err.code || 'un1t_busy')
      logWarn(LOG, 'un1t.online refused a fresh checkout; the row is left open', { ...ids, code: err.code ?? null })
      return { kind: 'not_resumable', state: 'refused' }
    }
    if (err instanceof Un1tWriteUnknown) {
      logWarn(LOG, 'fresh checkout unclear; the row is left open', { ...ids, code: err.code ?? null })
      return unavailable(err.code || 'outcome_unknown')
    }
    logError(LOG, 'fresh checkout threw', { ...ids, code: err?.code ?? null, errClass: err?.name })
    return unavailable('checkout_error')
  }
  if (checkout?.free === true || typeof checkout?.checkoutUrl !== 'string' || !checkout.checkoutUrl) {
    logWarn(LOG, 'fresh checkout carried no page to pay on', { ...ids, code: checkout?.free === true ? 'checkout_free' : 'checkout_no_url' })
    return unavailable('checkout_no_url')
  }

  // The row points at its newest checkout, and this guarded write is the last
  // look at it: a sweep that settled the row while un1t.online was answering
  // matches nothing, and the buyer is not sent to pay a purchase that has just
  // been confirmed. A write that FAILED is a warn line (the sweep settles on
  // un1t_user_id): the buyer still goes to pay.
  try {
    const { data, error } = await db.from('trial_purchases').update({ un1t_ledger_id: checkout.ledgerId ?? null })
      .eq('id', purchaseId).eq('location_id', locationId).eq('status', 'awaiting_payment').select('id')
    if (error) logWarn(LOG, 'un1t ledger id not stamped', { ...ids, ledgerId: checkout.ledgerId ?? null, code: error.code ?? null })
    else if (!Array.isArray(data) || data.length === 0) {
      logWarn(LOG, 'the row was settled while its checkout was being made; no checkout handed out', ids)
      return { kind: 'confirming', reason: 'paid_in_mirror' }
    }
  } catch (err) {
    logWarn(LOG, 'un1t ledger id not stamped', { ...ids, ledgerId: checkout.ledgerId ?? null, errClass: err?.name })
  }
  return { kind: 'redirect', checkoutUrl: checkout.checkoutUrl, reused: false, attempt: ledger.length + 1 }
}
