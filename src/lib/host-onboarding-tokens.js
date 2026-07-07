// Signed host-onboarding tokens (EVENTS-HOST.5).
//
// A unique signed link UN1T sends to an event host (email/WhatsApp/copy-paste).
// The host opens it with NO login and connects their OWN Stripe account via the
// token-gated public page (/host-connect/[token]); the token authenticates them
// as that host. Stateless HMAC, no DB column — mirrors event-checkin-tokens.
//
// Stripe-compliant: we email a link to OUR token page, never the Stripe Account
// Link itself; the Account Link is minted server-side when the host clicks
// "Connect", within the page session.
//
// Server-only (node:crypto).

import crypto from 'node:crypto'

const b64url = (input) => Buffer.from(input).toString('base64url')

/**
 * @param {{ hostId: string }} ids
 * @param {string} secret
 * @returns {string} `${payload}.${sig}`
 */
export function signHostOnboardingToken({ hostId }, secret) {
  const payload = b64url(JSON.stringify({ h: hostId, k: 'host_onboard' }))
  const sig = b64url(crypto.createHmac('sha256', String(secret || '')).update(payload).digest())
  return `${payload}.${sig}`
}

/**
 * @param {string} token
 * @param {string} secret
 * @returns {{ hostId: string }|null}
 */
export function verifyHostOnboardingToken(token, secret) {
  if (typeof token !== 'string' || !token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  if (!payload || !sig) return null
  const expected = b64url(crypto.createHmac('sha256', String(secret || '')).update(payload).digest())
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!obj || obj.k !== 'host_onboard' || !obj.h) return null
    return { hostId: obj.h }
  } catch {
    return null
  }
}
