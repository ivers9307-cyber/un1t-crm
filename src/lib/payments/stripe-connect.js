// Stripe Connect payment adapter (EVENTS-HOST.1 / .2).
//
// Third-party-hosted events settle here: a DIRECT charge onto the host's own
// connected account (Stripe-Account header), with a flat per-ticket booking
// fee kept by UN1T as the application_fee_amount. The host is merchant of
// record, so refunds/chargebacks debit the host and money never touches a
// UN1T balance.
//
// EVENTS-HOST.2 adds the onboarding half (create account, hosted onboarding
// link, status retrieval); EVENTS-HOST.3 the charge (createPayment via hosted
// Checkout); EVENTS-HOST.7 the refund (refundPayment on the connected account,
// with the booking-fee return handled by the operator refund route).

import { getStripe } from '../stripe'

export const provider = 'stripe_connect'

// ── Onboarding (EVENTS-HOST.2) ───────────────────────────────────────────────

/**
 * Create a Standard connected account for a host. Standard = host gets the
 * full Stripe dashboard, is merchant of record, and Stripe bears negative-
 * balance liability — the lowest-liability posture for a platform that is not
 * a licensed payments business.
 * @returns {Promise<string>} the connected account id (acct_…)
 */
export async function createConnectedAccount({ name, email, hostId, country = 'IE' }) {
  const stripe = getStripe()
  const account = await stripe.accounts.create({
    type: 'standard',
    country,
    email: email || undefined,
    business_profile: name ? { name } : undefined,
    metadata: { un1t_host_id: hostId || '' },
  })
  return account.id
}

/**
 * Mint a hosted-onboarding Account Link. MUST be presented inside an
 * authenticated operator session (never emailed/SMS'd) — Stripe's rule.
 * @returns {Promise<string>} the onboarding URL to redirect the browser to
 */
export async function createOnboardingLink({ accountId, refreshUrl, returnUrl }) {
  const stripe = getStripe()
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
    collection_options: { fields: 'eventually_due' },
  })
  return link.url
}

/**
 * Pull the live onboarding/capability status. `return_url` only means the host
 * exited the flow — the truth is here (and via the account.updated webhook).
 * @returns {Promise<{ chargesEnabled: boolean, payoutsEnabled: boolean, detailsSubmitted: boolean, requirementsCurrentlyDue: string[] }>}
 */
export async function retrieveAccountStatus(accountId) {
  const stripe = getStripe()
  const a = await stripe.accounts.retrieve(accountId)
  return {
    chargesEnabled: !!a.charges_enabled,
    payoutsEnabled: !!a.payouts_enabled,
    detailsSubmitted: !!a.details_submitted,
    requirementsCurrentlyDue: a.requirements?.currently_due || [],
  }
}

// ── Charges (stubbed until the charge slice) ─────────────────────────────────

/**
 * Create a Stripe Checkout Session as a DIRECT charge on the host's connected
 * account, with UN1T's per-ticket booking fee as the application fee. The
 * customer pays the ticket total PLUS the booking fee (two itemised lines); the
 * host receives the ticket total (less Stripe's own processing fee, which the
 * host bears under direct charges); UN1T keeps the fee. (EVENTS-HOST.3)
 *
 * Uses EMBEDDED checkout (`ui_mode: 'embedded'`): the buyer completes payment
 * inline on our own /event-pay page — no bounce to checkout.stripe.com. We
 * return the session's `client_secret` (as `checkoutToken`) which the browser
 * mounts via Stripe.js; there is no hosted URL. `redirect_on_completion:
 * 'if_required'` keeps card payments (incl. 3DS, handled in-widget) on-page and
 * only redirects to `return_url` for payment methods that genuinely need it, so
 * success is normally driven by the widget's onComplete + the Stripe webhook.
 * @returns {Promise<{ providerRef: string, checkoutToken: string|null, checkoutUrl: null, state: string, amountCents: number }>}
 */
export async function createPayment({
  amountCents, currency, description, returnUrl, metadata,
  connectedAccountId, applicationFeeCents = 0,
}) {
  if (!connectedAccountId) {
    throw new Error('Stripe Connect charge requires the host connected account id.')
  }
  const stripe = getStripe()
  const cur = String(currency || 'EUR').toLowerCase()
  const fee = Math.max(0, Number(applicationFeeCents) || 0)
  const ticketPortion = Math.max(0, Number(amountCents) - fee)

  const lineItems = [{
    price_data: { currency: cur, product_data: { name: description || 'Event entry' }, unit_amount: ticketPortion },
    quantity: 1,
  }]
  if (fee > 0) {
    lineItems.push({
      price_data: { currency: cur, product_data: { name: 'Booking fee' }, unit_amount: fee },
      quantity: 1,
    })
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    ui_mode: 'embedded',
    line_items: lineItems,
    // Direct charge: the application fee is skimmed to the platform; the rest
    // stays on the host's connected account. Omitted entirely when fee is 0.
    payment_intent_data: fee > 0 ? { application_fee_amount: fee } : undefined,
    // Embedded mode rejects success_url/cancel_url. return_url is only followed
    // for redirect-based methods; cards complete inline (onComplete).
    return_url: returnUrl,
    redirect_on_completion: 'if_required',
    metadata: metadata || {},
  }, { stripeAccount: connectedAccountId })

  return {
    providerRef: session.id,
    checkoutToken: session.client_secret,
    checkoutUrl: null,
    state: 'pending',
    amountCents: Number(amountCents),
  }
}

/**
 * Retrieve a Checkout Session's live state (on the host's connected account).
 * @returns {Promise<{ state: string, amountCents: number|null }|null>}
 */
export async function getPayment(providerRef, { connectedAccountId } = {}) {
  if (!connectedAccountId) return null
  const stripe = getStripe()
  const session = await stripe.checkout.sessions.retrieve(providerRef, { stripeAccount: connectedAccountId })
  if (!session) return null
  let state = 'pending'
  if (session.payment_status === 'paid') state = 'completed'
  else if (session.status === 'expired') state = 'cancelled'
  return { state, amountCents: Number.isFinite(session.amount_total) ? session.amount_total : null }
}

/**
 * Refund a Checkout Session's charge on the host's connected account (a DIRECT
 * charge). The refund debits the HOST's balance for the ticket portion. When
 * `refundApplicationFee` is set, Stripe ALSO returns UN1T's booking fee to the
 * host — used on a FULL refund so the customer is made whole and each party
 * gives back exactly what it received. A partial refund leaves the fee with
 * UN1T and comes out of the host's portion. (EVENTS-HOST.7)
 *
 * The refund attaches to the PaymentIntent, not the Checkout Session, so we
 * resolve the intent off the session first (on the connected account).
 *
 * @param {string} providerRef  the Checkout Session id (cs_…)
 * @param {object} opts
 * @param {number} opts.amountCents             refund amount in cents (partial or full)
 * @param {string} [opts.connectedAccountId]    acct_… (REQUIRED — merchant of record)
 * @param {boolean} [opts.refundApplicationFee] also refund UN1T's booking fee
 * @param {string} [opts.idempotencyKey]        Stripe idempotency key (retry-safe)
 * @returns {Promise<{ refundId: string|null }>}
 */
export async function refundPayment(providerRef, {
  amountCents, connectedAccountId, refundApplicationFee = false, idempotencyKey,
} = {}) {
  if (!connectedAccountId) {
    throw new Error('Stripe Connect refund requires the host connected account id.')
  }
  const stripe = getStripe()
  const session = await stripe.checkout.sessions.retrieve(providerRef, { stripeAccount: connectedAccountId })
  // session.payment_intent is the intent id string on an unexpanded retrieve.
  const paymentIntent = session?.payment_intent
  if (!paymentIntent) {
    throw new Error('Stripe Connect refund: session has no payment_intent (not paid).')
  }
  const amt = Math.max(0, Number(amountCents) || 0)
  const params = { payment_intent: paymentIntent }
  if (amt > 0) params.amount = amt          // omit → Stripe refunds the full remaining charge
  if (refundApplicationFee) params.refund_application_fee = true
  const requestOpts = { stripeAccount: connectedAccountId }
  if (idempotencyKey) requestOpts.idempotencyKey = idempotencyKey
  const refund = await stripe.refunds.create(params, requestOpts)
  return { refundId: refund?.id || null }
}
