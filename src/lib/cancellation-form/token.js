// CANCEL-FORM.3 — the capability token inside a cancellation form link.
//
// Same shape as start-prefill-token.js (stateless HMAC-SHA256 keyed on
// SUPABASE_SERVICE_ROLE_KEY, `${payload}.${sig}` both base64url, one null
// for every failure mode) with two deliberate differences:
//
//   - the payload is { l: linkId, e: exp } — the cancellation_form_links ROW
//     id, never the contact id. A leaked or forwarded token discloses nothing
//     on its own; the row (which the public route resolves by id AND by the
//     token's fingerprint) is the only map from link to person, and it is
//     what makes the link single-use and revocable per send.
//   - it EXPIRES (30 days). This token authorises a write against someone's
//     membership on their behalf, which is exactly the class the prefill
//     token's docblock says must not live forever. Links get forwarded.

import crypto from 'node:crypto'

const b64url = (input) => Buffer.from(input).toString('base64url')

export const CANCELLATION_FORM_TTL_DAYS = 30

function getSecret() {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set — cannot sign or verify cancellation form tokens.')
  }
  return secret
}

/**
 * @param {{linkId:string, ttlDays?:number, now?:number}} args
 * @returns {string}
 */
export function signCancellationFormToken({ linkId, ttlDays = CANCELLATION_FORM_TTL_DAYS, now = Date.now() } = {}) {
  if (!linkId) throw new Error('signCancellationFormToken: linkId is required')
  const secret = getSecret()
  const exp = Math.floor(now / 1000) + Math.round(ttlDays * 24 * 3600)
  const payload = b64url(JSON.stringify({ l: linkId, e: exp }))
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest())
  return `${payload}.${sig}`
}

/**
 * @param {string} token
 * @param {{now?:number}} [opts]
 * @returns {{linkId:string, exp:number}|null}
 */
export function verifyCancellationFormToken(token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token) return null
  const secret = getSecret()
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  if (!payload || !sig) return null
  const expected = b64url(crypto.createHmac('sha256', secret).update(payload).digest())
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  // Length check first: timingSafeEqual THROWS on a length mismatch.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!obj || typeof obj !== 'object' || typeof obj.l !== 'string' || !obj.l) return null
    // No expiry = not one of ours (or hand-made). Fail closed.
    if (!Number.isFinite(obj.e)) return null
    if (Math.floor(now / 1000) > obj.e) return null
    return { linkId: obj.l, exp: obj.e }
  } catch {
    return null
  }
}
