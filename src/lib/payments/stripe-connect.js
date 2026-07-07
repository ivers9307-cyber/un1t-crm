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

const CHARGE_NOT_READY =
  'Stripe Connect charges are not wired yet — onboarding (EVENTS-HOST.2) shipped first; ' +
  'the direct-charge/refund path lands in the next slice.'

// eslint-disable-next-line no-unused-vars
export async function createPayment(_args) {
  throw new Error(CHARGE_NOT_READY)
}

// eslint-disable-next-line no-unused-vars
export async function getPayment(_providerRef) {
  throw new Error(CHARGE_NOT_READY)
}

// eslint-disable-next-line no-unused-vars
export async function refundPayment(_providerRef, _opts) {
  throw new Error(CHARGE_NOT_READY)
}
