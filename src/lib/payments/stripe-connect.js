// Stripe Connect payment adapter (EVENTS-HOST.1 / .2).
//
// Third-party-hosted events settle here: a DIRECT charge onto the host's own
// connected account (Stripe-Account header), with a flat per-ticket booking
// fee kept by UN1T as the application_fee_amount. The host is merchant of
// record, so refunds/chargebacks debit the host and money never touches a
// UN1T balance.
//
// EVENTS-HOST.2 adds the onboarding half (create account, hosted onboarding
// link, status retrieval). The charge/refund half (createPayment/…) is still
// stubbed — it lands in the next slice once onboarding is verified end-to-end.

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
 * customer pays the ticket total PLUS the booking fee (itemised on Stripe's
 * page); the host receives the ticket total (less Stripe's own processing fee,
 * which the host bears under direct charges); UN1T keeps the fee. Returns the
 * hosted Checkout URL to redirect the buyer to (no embedded widget — SCA/3DS
 * is handled by Checkout). (EVENTS-HOST.3)
 * @returns {Promise<{ providerRef: string, checkoutToken: null, checkoutUrl: string, state: string, amountCents: number }>}
 */
export async function createPayment({
  amountCents, currency, description, returnUrl, cancelUrl, metadata,
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
    line_items: lineItems,
    // Direct charge: the application fee is skimmed to the platform; the rest
    // stays on the host's connected account. Omitted entirely when fee is 0.
    payment_intent_data: fee > 0 ? { application_fee_amount: fee } : undefined,
    success_url: returnUrl,
    cancel_url: cancelUrl || returnUrl,
    metadata: metadata || {},
  }, { stripeAccount: connectedAccountId })

  return {
    providerRef: session.id,
    checkoutToken: null,
    checkoutUrl: session.url,
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

// Stripe Connect refunds are a follow-up slice. The operator refund route
// still rejects any non-'revolut' provider, so this path is never reached
// today (a Stripe refund attempt 400s cleanly rather than mis-refunding).
// eslint-disable-next-line no-unused-vars
export async function refundPayment(_providerRef, _opts) {
  throw new Error('Stripe Connect refunds are not wired yet (follow-up slice).')
}
