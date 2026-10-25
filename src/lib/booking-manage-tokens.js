// Signed booking-manage tokens (BOOKINGSELF.1).
//
// The link in a booking confirmation and reminder email ({{manage_url}})
// that lets the person who booked cancel or reschedule it with no login:
// /book/manage/[token]. The token names one `bookings` row and is the only
// credential the /api/public/booking-manage/[token] routes accept, so it is
// HMAC-SHA256 on the service-role key (as entry-manage-tokens is), carries a
// kind ('booking_manage', so an entry-manage, check-in or host token signed
// with the same key never passes as one, and this one never passes as
// theirs) and an `iat`, and expires after BOOKING_MANAGE_TOKEN_TTL_MS. A
// token with no iat, one stamped in the future, a bad signature or an empty
// secret all verify to null; the routes answer every such case 404.
//
// 90 days: a booking can be made up to max_advance_days ahead and the link
// sits in the confirmation until then; every reminder and every reschedule
// confirmation carries a fresh one.
//
// Server-only (node:crypto).

import crypto from 'node:crypto'
import { getAppUrl } from './app-url'

const KIND = 'booking_manage'
const b64url = (input) => Buffer.from(input).toString('base64url')
const hmac = (payload, secret) => b64url(crypto.createHmac('sha256', String(secret)).update(payload).digest())

export const BOOKING_MANAGE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000
// Tolerate a minute of clock skew between the minting and verifying hosts.
const SKEW_MS = 60 * 1000

/**
 * @param {{ bookingId: string }} ids
 * @param {string} secret
 * @param {{ nowMs?: number }} [opts]  injectable clock for tests
 * @returns {string} `${payload}.${sig}`
 */
export function signBookingManageToken({ bookingId }, secret, { nowMs = Date.now() } = {}) {
  if (!secret) throw new Error('signBookingManageToken: no secret')
  if (!bookingId) throw new Error('signBookingManageToken: no booking id')
  const payload = b64url(JSON.stringify({ b: String(bookingId), k: KIND, iat: nowMs }))
  return `${payload}.${hmac(payload, secret)}`
}

/**
 * @param {string} token
 * @param {string} secret
 * @param {{ nowMs?: number, ttlMs?: number }} [opts]  injectable clock/TTL for tests
 * @returns {{ bookingId: string }|null}
 */
export function verifyBookingManageToken(token, secret, { nowMs = Date.now(), ttlMs = BOOKING_MANAGE_TOKEN_TTL_MS } = {}) {
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
    if (!obj || obj.k !== KIND || typeof obj.b !== 'string' || !obj.b) return null
    if (typeof obj.iat !== 'number' || !Number.isFinite(obj.iat)) return null
    if (obj.iat > nowMs + SKEW_MS) return null
    if (nowMs - obj.iat > ttlMs) return null
    return { bookingId: obj.b }
  } catch {
    return null
  }
}

/** Verify with the service-role key, as every public booking-manage route does. */
export function verifyBookingManageTokenFromEnv(token) {
  return verifyBookingManageToken(token, process.env.SUPABASE_SERVICE_ROLE_KEY || null)
}

/**
 * The absolute manage link for a booking, or null when it cannot be built
 * (no id, no signing key, no app URL). Never throws: an email that cannot
 * carry the link still goes out without it.
 *
 * The send paths hand in `baseUrl`, the booking location's customer host
 * (resolveCustomerBaseUrl), so a tenant's customers never see the CRM host;
 * without one it floors to the app URL.
 */
export function bookingManageUrl(bookingId, { baseUrl: handed = null } = {}) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || null
  if (!bookingId || !secret) return null
  let baseUrl = typeof handed === 'string' ? handed.replace(/\/+$/, '') : ''
  if (!baseUrl) {
    try { baseUrl = getAppUrl() } catch { return null }
  }
  return `${baseUrl}/book/manage/${signBookingManageToken({ bookingId }, secret)}`
}
