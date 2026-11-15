// TRIALLEAK.1 — how long a /trial checkout stays open, and the rules that hang
// off that one number. Pure and client-safe (the card and the routes both
// read it): no IO.
//
// A buyer from a Meta ad pays inside Facebook's or Instagram's in-app browser,
// which reloads the page when they come back from their banking app. The
// order therefore lives for two hours (not the 30-minute default every other
// checkout keeps), and for almost that long the SAME row and order are handed
// back: to a reload (`?purchase=<id>` remounts the widget) and to a second
// press of the pay button (no second row, no second order).
import { isoDurationFromSeconds } from './revolut-order-fields'

/** How long a trial order stays payable at the provider. */
export const TRIAL_CHECKOUT_EXPIRE_SECONDS = 2 * 60 * 60
/** The same, as the ISO 8601 duration the order is created with. */
export const TRIAL_CHECKOUT_EXPIRE_AFTER = isoDurationFromSeconds(TRIAL_CHECKOUT_EXPIRE_SECONDS)
/** Margin kept between "we still hand this checkout out" and "the provider has closed it". */
const REUSE_MARGIN_SECONDS = 10 * 60
/** How long after the row was created its checkout is still handed out (110 minutes). */
export const TRIAL_CHECKOUT_REUSE_MS = (TRIAL_CHECKOUT_EXPIRE_SECONDS - REUSE_MARGIN_SECONDS) * 1000

const ageMsOf = (row, nowMs) => {
  const t = Date.parse(row?.created_at || '')
  return Number.isFinite(t) ? nowMs - t : null
}

/**
 * Can this row's checkout still be shown to the buyer? Only the CRM's own
 * embedded Revolut checkout: an open, unpaid row with a token, young enough
 * that the order behind it is still payable. A Hatch Street row (un1t.online's
 * hosted checkout, whose URL is never stored) is never usable.
 */
export function trialCheckoutUsable(row, nowMs = Date.now()) {
  if (!row) return false
  if (row.status !== 'awaiting_payment' || row.payment_status !== 'pending') return false
  if (row.payment_provider !== 'revolut' || !row.payment_checkout_token) return false
  const age = ageMsOf(row, nowMs)
  return age !== null && age >= 0 && age < TRIAL_CHECKOUT_REUSE_MS
}

/**
 * Why an unpaid order ended, for the row (staff and reports; the buyer's
 * screen reads only `payment_status`). Revolut reports an order that ran out
 * of time as `failed`, exactly like a refused payment, so a `failed` that
 * arrives once the order's time is up is read as the expiry it is.
 * @returns {{ payment_status: 'failed'|'expired', reason: 'payment_declined'|'checkout_expired'|'checkout_cancelled' }|null}
 */
export function trialPaymentFailure(providerState, row, nowMs = Date.now()) {
  const state = String(providerState || '').toLowerCase()
  if (state === 'cancelled') return { payment_status: 'expired', reason: 'checkout_cancelled' }
  if (state === 'expired') return { payment_status: 'expired', reason: 'checkout_expired' }
  if (state !== 'failed') return null
  const age = ageMsOf(row, nowMs)
  // A minute of slack: the row is written a moment before the order is opened.
  const ranOut = age !== null && age >= (TRIAL_CHECKOUT_EXPIRE_SECONDS - 60) * 1000
  return ranOut
    ? { payment_status: 'expired', reason: 'checkout_expired' }
    : { payment_status: 'failed', reason: 'payment_declined' }
}

/**
 * Facebook's or Instagram's in-app browser, from a user agent. Instagram first:
 * its user agent can carry Facebook's markers too.
 * @returns {'instagram'|'facebook'|null}
 */
export function inAppBrowserFromUserAgent(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent : ''
  if (/Instagram/i.test(ua)) return 'instagram'
  if (/FBAN|FBAV|FB_IAB/.test(ua)) return 'facebook'
  return null
}

// ── HATCHTRACK.1 — Hatch Street (un1t.online's hosted checkout) ──────────────
//
// un1t.online's checkout is a Stripe Checkout page. Stripe keeps a session
// open after the buyer presses Back and never closes one sooner than 30
// minutes after it was made; how long un1t.online keeps its own open is not
// written down anywhere the CRM can read (the settle sweep assumes 24 hours).
// So a stored URL is handed back only inside the part of its life that is
// certain, and after that the SAME purchase row is given a fresh checkout.

/** How long a stored un1t.online checkout URL is handed back before a fresh one is made. */
export const UN1T_CHECKOUT_REUSE_MS = 20 * 60_000
/** How old a Hatch row may be and still be given a checkout (the abandoned follow-up's own window). */
export const UN1T_TRIAL_RESUME_MAX_AGE_MS = 72 * 60 * 60_000
/** How long the follow-up's link names the purchase: the row's life before the settle sweep expires it. */
export const UN1T_TRIAL_RESUME_LINK_MS = 24 * 60 * 60_000

/**
 * Can this Hatch Street row be sent back to payment? An unpaid row the settle
 * sweep can still settle (it carries the un1t.online account and product),
 * young enough. Never a Stillorgan row (trialCheckoutUsable is its rule).
 */
export function un1tTrialRetryable(row, nowMs = Date.now()) {
  if (!row) return false
  if (row.payment_provider !== 'un1t_online' || row.status !== 'awaiting_payment') return false
  if (!row.un1t_user_id || !row.un1t_product_id) return false
  const age = ageMsOf(row, nowMs)
  return age !== null && age >= 0 && age < UN1T_TRIAL_RESUME_MAX_AGE_MS
}
