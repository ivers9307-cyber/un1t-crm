// Payments provider dispatcher (EVENTS-HOST.1).
//
// Routes a payment operation to the right processor adapter by provider name,
// so domain code (race-payments, refunds, webhooks) stays processor-agnostic.
// The routing decision itself lives in src/lib/event-hosts.js
// (resolvePaymentProvider): internal/UN1T events → revolut; third-party-hosted
// events → stripe_connect (the host's own connected account).
//
// The live race-payments.js / refund / webhook paths are rewired onto this
// dispatcher in the Stripe Connect PR (bundled with the real stripe-connect
// adapter so the swap is verified end-to-end); this module + adapters are the
// tested seam that lands first.

import * as revolut from './revolut'
import * as stripeConnect from './stripe-connect'

const ADAPTERS = {
  revolut,
  stripe_connect: stripeConnect,
}

/** Provider names the dispatcher can route (excludes 'free' — free entries never hit a processor). */
export const PAYMENT_PROVIDERS = Object.keys(ADAPTERS)

/**
 * Resolve the adapter for a provider name.
 * @param {'revolut'|'stripe_connect'} providerName
 * @returns {{ provider: string, createPayment: Function, getPayment: Function, refundPayment: Function }}
 */
export function paymentsFor(providerName) {
  const adapter = ADAPTERS[providerName]
  if (!adapter) throw new Error(`Unknown payment provider: ${providerName}`)
  return adapter
}
