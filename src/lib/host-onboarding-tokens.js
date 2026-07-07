// Signed host-onboarding tokens (EVENTS-HOST.5).
//
// A unique signed link UN1T sends to an event host (email/WhatsApp/copy-paste).
// The host opens it with NO login and connects their OWN Stripe account via the
// token-gated public page (/host-connect/[token]); the token authenticates them
// as that host. Stateless HMAC, no DB column — mirrors event-checkin-tokens.
//
// EVENTS-HOST.6: the token is time-boxed. The payload carries an `iat`
// (issued-at, ms) and verification rejects anything older than
// HOST_ONBOARDING_TOKEN_TTL_MS (or a token minted with no iat at all — a
// leaked link is a bearer capability for the host's payout destination, so a
// permanent one is the risk the TTL closes). If a link expires the operator
// just re-mints it (one click on the host page). A small forward-skew guard
// rejects tokens stamped in the future (a tampered/forged iat).
//
// Stripe-compliant: we email a link to OUR token page, never the Stripe Account
// Link itself; the Account Link is minted server-side when the host clicks
// "Connect", within the page session.
//
// Server-only (node:crypto).

import crypto from 'node:crypto'

const b64url = (input) => Buffer.from(input).toString('base64url')

// 7 days: long enough for a host to act on an emailed link, short enough that
// a leaked link is not a standing liability. Re-minting is a one-click op.
export const HOST_ONBOARDING_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
// Tolerate a minute of clock skew between the minting and verifying hosts.
const SKEW_MS = 60 * 1000

/**
 * @param {{ hostId: string }} ids
 * @param {string} secret
 * @param {{ nowMs?: number }} [opts]  injectable clock for tests
 * @returns {string} `${payload}.${sig}`
 */
export function signHostOnboardingToken({ hostId }, secret, { nowMs = Date.now() } = {}) {
  const payload = b64url(JSON.stringify({ h: hostId, k: 'host_onboard', iat: nowMs }))
  const sig = b64url(crypto.createHmac('sha256', String(secret || '')).update(payload).digest())
  return `${payload}.${sig}`
}

/**
 * @param {string} token
 * @param {string} secret
 * @param {{ nowMs?: number, ttlMs?: number }} [opts]  injectable clock/TTL for tests
 * @returns {{ hostId: string }|null}
 */
export function verifyHostOnboardingToken(token, secret, { nowMs = Date.now(), ttlMs = HOST_ONBOARDING_TOKEN_TTL_MS } = {}) {
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
    // Reject unstamped (legacy/forged) or expired tokens — fail closed.
    if (typeof obj.iat !== 'number' || !Number.isFinite(obj.iat)) return null
    if (obj.iat > nowMs + SKEW_MS) return null       // stamped in the future
    if (nowMs - obj.iat > ttlMs) return null          // older than the TTL
    return { hostId: obj.h }
  } catch {
    return null
  }
}
