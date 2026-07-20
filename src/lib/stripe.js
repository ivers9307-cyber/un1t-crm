// Stripe client + webhook verification (EVENTS-HOST.2).
//
// The platform-side Stripe client for Stripe Connect. Third-party event hosts
// are onboarded as STANDARD connected accounts and paid via DIRECT charges
// (host = merchant of record; UN1T keeps a per-ticket application fee). Mirrors
// the shape of src/lib/revolut.js: a lazily-built singleton keyed off an env
// var that throws a clear error if unset, so a missing key fails loud rather
// than silently no-op'ing a payment.
//
// STRIPE_SECRET_KEY       — platform secret key (sk_live_… / sk_test_…)
// STRIPE_WEBHOOK_SECRET   — signing secret of the /api/webhooks/stripe endpoint
//                           (created in the Stripe dashboard AFTER deploy, with
//                           "listen to events on connected accounts" enabled so
//                           account.updated / payout events for hosts arrive).

import Stripe from 'stripe'

let _client = null

/**
 * The shared platform Stripe client. Throws if STRIPE_SECRET_KEY is unset
 * (no silent fallback — same posture as getConfig() in revolut.js).
 * @returns {import('stripe').Stripe}
 */
export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not configured. Set it in environment variables ' +
      '(Stripe Dashboard → Developers → API keys). Test keys start sk_test_, live sk_live_.',
    )
  }
  // Pin the SDK's bundled API version (omit → the installed stripe package
  // decides), so upgrading the package is the deliberate migration point.
  if (!_client) _client = new Stripe(key)
  return _client
}

/**
 * Verify + parse a Stripe webhook. Throws on a bad signature (caller returns
 * 400). Requires the RAW request body (never the parsed JSON).
 * @param {string|Buffer} rawBody
 * @param {string} signatureHeader  value of the `Stripe-Signature` header
 * @returns {import('stripe').Stripe.Event}
 */
export function verifyStripeWebhook(rawBody, signatureHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured.')
  return getStripe().webhooks.constructEvent(rawBody, signatureHeader, secret)
}

/** True when the Stripe platform key is present (gate for showing Connect UI / routes). */
export function isStripeConfigured() {
  return !!process.env.STRIPE_SECRET_KEY
}

// ── Wallet top-ups (INTEG-C2b) ──────────────────────────────────────────────
// Wallet top-ups are PLAIN platform charges on the same Stripe account —
// no connected-account params anywhere. They get their OWN webhook
// endpoint (/api/webhooks/stripe-wallet) with its OWN signing secret so
// the Connect-events endpoint above and the wallet endpoint can never
// consume each other's deliveries.

/**
 * Verify + parse a wallet-top-up webhook (STRIPE_WALLET_WEBHOOK_SECRET).
 * Throws on a bad signature OR a missing secret — deliberately NO
 * fallback to STRIPE_WEBHOOK_SECRET (a wallet event verified against
 * the Connect endpoint's secret would be a config error, not a feature).
 * The route turns the missing-secret case into a 503 BEFORE calling
 * this, keeping the endpoint safely inert until configured.
 * @param {string|Buffer} rawBody
 * @param {string} signatureHeader  value of the `Stripe-Signature` header
 * @returns {import('stripe').Stripe.Event}
 */
export function verifyStripeWalletWebhook(rawBody, signatureHeader) {
  const secret = process.env.STRIPE_WALLET_WEBHOOK_SECRET
  if (!secret) throw new Error('STRIPE_WALLET_WEBHOOK_SECRET is not configured.')
  return getStripe().webhooks.constructEvent(rawBody, signatureHeader, secret)
}

/** True when the wallet webhook signing secret is configured. */
export function isStripeWalletWebhookConfigured() {
  return !!process.env.STRIPE_WALLET_WEBHOOK_SECRET
}
