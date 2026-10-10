// Signed entry-manage tokens (EVENT-MOVE.6).
//
// The link in an event confirmation (and moved) email that lets the person
// who booked an entry manage it with no login: /event/entry/[token]. The
// token names one race_registrations row and is the only credential the
// public entry routes accept, so it is HMAC-SHA256 on the service-role key
// (as event-checkin-tokens and host-onboarding-tokens are), carries a kind
// ('entry_manage', so no other token signed with the same key passes as
// one) and an `iat`, and expires after ENTRY_MANAGE_TOKEN_TTL_MS. A token
// with no iat, one stamped in the future, a bad signature or an empty
// secret all verify to null; the routes answer every such case 404.
//
// 90 days: a booking is usually made weeks ahead and the link sits in the
// confirmation email until then; a fresh one goes out with every moved
// email. Unlike the host link, this one cannot reach money that is not the
// holder's own: a dearer move still goes through checkout.
//
// Server-only (node:crypto).

import crypto from 'node:crypto'
import { getAppUrl } from './app-url'

const KIND = 'entry_manage'
const b64url = (input) => Buffer.from(input).toString('base64url')
const hmac = (payload, secret) => b64url(crypto.createHmac('sha256', String(secret)).update(payload).digest())

export const ENTRY_MANAGE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000
// Tolerate a minute of clock skew between the minting and verifying hosts.
const SKEW_MS = 60 * 1000

/**
 * @param {{ registrationId: string }} ids
 * @param {string} secret
 * @param {{ nowMs?: number }} [opts]  injectable clock for tests
 * @returns {string} `${payload}.${sig}`
 */
export function signEntryManageToken({ registrationId }, secret, { nowMs = Date.now() } = {}) {
  if (!secret) throw new Error('signEntryManageToken: no secret')
  if (!registrationId) throw new Error('signEntryManageToken: no registration id')
  const payload = b64url(JSON.stringify({ r: String(registrationId), k: KIND, iat: nowMs }))
  return `${payload}.${hmac(payload, secret)}`
}

/**
 * @param {string} token
 * @param {string} secret
 * @param {{ nowMs?: number, ttlMs?: number }} [opts]  injectable clock/TTL for tests
 * @returns {{ registrationId: string }|null}
 */
export function verifyEntryManageToken(token, secret, { nowMs = Date.now(), ttlMs = ENTRY_MANAGE_TOKEN_TTL_MS } = {}) {
  if (!secret || typeof token !== 'string' || !token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  if (!payload || !sig) return null
  const a = Buffer.from(sig)
  const b = Buffer.from(hmac(payload, secret))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!obj || obj.k !== KIND || typeof obj.r !== 'string' || !obj.r) return null
    if (typeof obj.iat !== 'number' || !Number.isFinite(obj.iat)) return null
    if (obj.iat > nowMs + SKEW_MS) return null
    if (nowMs - obj.iat > ttlMs) return null
    return { registrationId: obj.r }
  } catch {
    return null
  }
}

/** Verify with the service-role key, as every public entry route does. */
export function verifyEntryManageTokenFromEnv(token) {
  return verifyEntryManageToken(token, process.env.SUPABASE_SERVICE_ROLE_KEY || null)
}

/**
 * The absolute manage link for an entry, or null when it cannot be built (no
 * id, no signing key, no app URL). Never throws: an email that cannot carry
 * the link still goes out without it.
 */
export function entryManageUrl(registrationId) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || null
  if (!registrationId || !secret) return null
  let origin
  try { origin = getAppUrl() } catch { return null }
  return `${origin}/event/entry/${signEntryManageToken({ registrationId }, secret)}`
}
