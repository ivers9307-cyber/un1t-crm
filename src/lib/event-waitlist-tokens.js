// EVENT-WAITLIST.1 — the claim token in a waitlist offer link
// (/event/<slug>?wl=<token>). It names ONE event_waitlist row, so that when the
// person books through the link the register route can mark that row claimed.
//
// It carries identity, never authority: the booking itself is an ordinary
// public registration that goes through the register route's own capacity
// gate (first to book wins), and nothing here holds a place. A forwarded link
// can at worst mark the original row claimed when the friend books, which
// takes that person off the list after a booking was made through their offer.
//
// Stateless HMAC-SHA256, the shape of signStartPrefillToken / signCheckinToken.
// The payload carries a purpose tag (`p: 'wl'`) so a token minted for another
// purpose with the same secret can never verify here. 14-day expiry: an offer
// is only useful while the event is ahead, and a stale link should not quietly
// claim a row weeks later.
//
// Server-only (node:crypto).

import crypto from 'node:crypto'

export const WAITLIST_CLAIM_TTL_DAYS = 14
const PURPOSE = 'wl'

const b64url = (input) => Buffer.from(input).toString('base64url')
const sign = (payload, secret) => b64url(crypto.createHmac('sha256', String(secret || '')).update(payload).digest())

/**
 * @param {{ waitlistId: string, now?: number, ttlDays?: number }} args
 * @param {string} secret
 * @returns {string} `${payload}.${sig}`, URL-safe as-is
 */
export function signWaitlistClaimToken({ waitlistId, now = Date.now(), ttlDays = WAITLIST_CLAIM_TTL_DAYS }, secret) {
  if (!waitlistId) throw new Error('signWaitlistClaimToken: waitlistId is required')
  if (!secret) throw new Error('signWaitlistClaimToken: secret is required')
  const exp = Math.floor(now / 1000) + Math.round(ttlDays * 24 * 3600)
  const payload = b64url(JSON.stringify({ p: PURPOSE, w: waitlistId, e: exp }))
  return `${payload}.${sign(payload, secret)}`
}

/**
 * @param {string} token
 * @param {string} secret
 * @param {{ now?: number }} [opts]
 * @returns {{ waitlistId: string } | null}  null for anything malformed, forged or expired
 */
export function verifyWaitlistClaimToken(token, secret, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token || !secret) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  if (!payload || !sig) return null
  const a = Buffer.from(sig)
  const b = Buffer.from(sign(payload, secret))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!obj || obj.p !== PURPOSE || typeof obj.w !== 'string' || !obj.w) return null
    if (!Number.isFinite(obj.e) || obj.e * 1000 < now) return null
    return { waitlistId: obj.w }
  } catch {
    return null
  }
}

/** The secret every waitlist claim token is signed with (estate-wide rotation = rotate the key). */
export function waitlistTokenSecret() {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set: cannot sign or verify waitlist claim tokens.')
  return secret
}
