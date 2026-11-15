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
import { UN1T_TRIAL_ORIGIN, un1tTrialReturnUrls } from '@/lib/trial-purchase-un1t-checkout'
import { logWarn, logError } from '@/lib/log'

const LOG = 'trialbuy-resume'
const ROW_COLS = 'id, location_id, status, payment_status, payment_provider, un1t_user_id, un1t_product_id, created_at'
const LEDGER_COLS = 'id, stage, checkout_url, idempotency_key, created_at'
const OPEN_STAGES = new Set(['sent', 'unknown'])

const unavailable = (code) => ({ kind: 'unavailable', code })

/**
 * @param {object} db service-role client
 * @param {{ purchaseId: string, returnPath?: string, now?: () => number }} args
 *   returnPath: already allowlisted by the caller (trial-return-path.js)
 * @returns {Promise<
 *   { kind: 'redirect', checkoutUrl: string, reused: boolean, attempt: number }
 *   | { kind: 'not_found' }
 *   | { kind: 'not_resumable', state: string }
 *   | { kind: 'unavailable', code: string }>} never throws
 */
export async function resumeUn1tTrialCheckout(db, { purchaseId, returnPath = '/trial', now = () => Date.now() } = {}, deps = {}) {
  const { createLink = createCheckoutLink } = deps
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

  // The row's checkouts so far (newest first), for this account and product only.
  let ledger
  try {
    const { data, error } = await db.from('un1t_write_events').select(LEDGER_COLS)
      .eq('location_id', locationId).eq('op', 'checkout').eq('origin_ref', purchaseId)
      .eq('un1t_user_id', String(row.un1t_user_id)).eq('target', row.un1t_product_id)
      .order('created_at', { ascending: false }).range(0, 99)
    if (error) throw Object.assign(new Error('ledger unreadable'), { code: error.code ?? null })
    ledger = Array.isArray(data) ? data : []
  } catch (err) {
    logError(LOG, 'checkout ledger unreadable; no checkout', { ...ids, code: err?.code ?? null, errClass: err?.name })
    return unavailable('ledger_unreadable')
  }

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
    : `trial_purchase:${purchaseId}:r${ledger.length}`
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

  // The row points at its newest checkout; the sweep settles on un1t_user_id,
  // so a link that could not be written is a warn line, not a failure.
  if (checkout.ledgerId) {
    try {
      const { error } = await db.from('trial_purchases').update({ un1t_ledger_id: checkout.ledgerId })
        .eq('id', purchaseId).eq('location_id', locationId).eq('status', 'awaiting_payment')
      if (error) logWarn(LOG, 'un1t ledger id not stamped', { ...ids, ledgerId: checkout.ledgerId, code: error.code ?? null })
    } catch (err) {
      logWarn(LOG, 'un1t ledger id not stamped', { ...ids, ledgerId: checkout.ledgerId, errClass: err?.name })
    }
  }
  return { kind: 'redirect', checkoutUrl: checkout.checkoutUrl, reused: false, attempt: ledger.length + 1 }
}
