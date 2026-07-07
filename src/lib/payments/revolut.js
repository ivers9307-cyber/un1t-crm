// Revolut payment adapter (EVENTS-HOST.1).
//
// Wraps the generic Revolut Merchant transport (src/lib/revolut.js) in the
// provider-agnostic interface consumed by the payments dispatcher
// (src/lib/payments/index.js). Behaviour-identical to the direct revolut.js
// calls that race-payments.js makes today — this is the seam that lets Stripe
// Connect slot in as a peer without the domain code caring which processor
// settles the money. Internal/UN1T events settle here.

import {
  createOrder as revolutCreateOrder,
  getOrder as revolutGetOrder,
  refundOrder as revolutRefundOrder,
} from '../revolut'

export const provider = 'revolut'

/**
 * Create a checkout order.
 * @returns {Promise<{ providerRef: string, checkoutToken: string|null, checkoutUrl: string|null, state: string, amountCents: number }>}
 */
export async function createPayment({ amountCents, currency, description, returnUrl, metadata, idempotencyKey }) {
  const order = await revolutCreateOrder({
    amount: amountCents,
    currency,
    description,
    redirectUrl: returnUrl,
    metadata,
    idempotencyKey,
  })
  return {
    providerRef: order.id,
    checkoutToken: order.token || null,
    checkoutUrl: order.checkout_url || null,
    state: String(order.state || '').toLowerCase(),
    amountCents: Number.isFinite(order.amount) ? order.amount : amountCents,
  }
}

/**
 * Fetch the live state of an order (webhook + return-page truth source).
 * @returns {Promise<{ state: string, amountCents: number|null }|null>}
 */
export async function getPayment(providerRef) {
  const order = await revolutGetOrder(providerRef)
  if (!order) return null
  return {
    state: String(order.state || '').toLowerCase(),
    amountCents: Number.isFinite(order.amount) ? order.amount : null,
  }
}

/**
 * Refund (full or partial). Revolut mints a new refund order under the hood.
 * @returns {Promise<{ refundId: string|null }>}
 */
export async function refundPayment(providerRef, { amountCents, currency, description }) {
  const res = await revolutRefundOrder(providerRef, { amount: amountCents, currency, description })
  return { refundId: res?.id || null }
}
