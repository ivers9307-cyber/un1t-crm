// XERO-WEBHOOK — shared helpers for the Xero webhook endpoint.
//
// Xero signs every webhook delivery: HMAC-SHA256 of the exact raw
// request body, keyed with the per-webhook signing key from the
// Xero developer portal, base64-encoded, sent in the
// `x-xero-signature` header. The endpoint must verify it before
// trusting anything in the payload — and Xero's "intent to receive"
// setup check relies on the same comparison (a 200 for a valid
// signature, 401 for an invalid one).

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verify a Xero webhook signature.
 *
 * @param {string} rawBody    the exact request body bytes, as text
 * @param {string} headerSig  the `x-xero-signature` header value
 * @param {string} key        the webhook signing key (XERO_WEBHOOK_KEY)
 * @returns {boolean} true only on an exact, timing-safe match
 */
export function verifyXeroSignature(rawBody, headerSig, key) {
  if (!key || !headerSig) return false
  const computed = createHmac('sha256', key).update(rawBody || '').digest('base64')
  // timingSafeEqual throws on unequal-length buffers — length-check first.
  const a = Buffer.from(computed)
  const b = Buffer.from(String(headerSig))
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}
