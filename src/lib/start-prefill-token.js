// STARTPREFILL.1 — a capability token that lets /start fill its own form in.
//
// WHY THIS EXISTS
// The 3-Class Trial sequence emails 2,450 people whose first name, last name,
// email and phone we already hold, tells them their classes are "sitting on
// your account", and then lands them on a form asking them to type all four in.
// Measured 2026-08-20: 138 arrived, 26 completed the form. Asking someone to
// re-enter data you already have is the cheapest friction there is to remove.
//
// Stateless HMAC-SHA256 keyed on SUPABASE_SERVICE_ROLE_KEY — the same shape as
// signHostUnsubToken (host-unsubscribe.js) and signCheckinToken. No table, no
// migration, and revocable estate-wide by rotating the secret.
//
// 🔴 WHY IT CARRIES AN EXPIRY, WHICH THE UNSUBSCRIBE TOKEN DOES NOT
// This token resolves to a person's NAME, EMAIL AND PHONE. An unsubscribe token
// only ever removes consent, so a leaked one is self-limiting; a leaked prefill
// token discloses contact details for as long as it is valid. The sequence's
// own copy actively encourages forwarding ("Bring someone with you if it
// helps"), so links WILL travel. The expiry bounds that: a forwarded link goes
// stale rather than disclosing a stranger's details indefinitely.
//
// 🔴 WHY THE FORM IS PREFILLED AND NEVER SKIPPED
// Same reason. If a forwarded link skipped straight to booking, the friend
// would be booked silently under the original recipient's identity — wrong
// person, no signal, discovered only when someone turns up who isn't on the
// list. Prefilled-but-visible makes that failure obvious and self-correcting:
// the friend sees a name that isn't theirs in an editable field and changes it.
// See the resolve route and ClassFunnel for the other half of this.

import crypto from 'node:crypto'

const b64url = (input) => Buffer.from(input).toString('base64url')

// The trial arc is 21 days and each email mints a fresh token at send time, so
// this only has to cover "how long after receiving might someone click".
// Generous, but far short of indefinite.
export const PREFILL_TTL_DAYS = 45

function getSecret() {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set — cannot sign or verify start prefill tokens.')
  }
  return secret
}

/**
 * @param {{contactId:string, ttlDays?:number, now?:number}} args
 * @returns {string} `${payload}.${sig}` — both base64url, URL-safe as-is.
 */
export function signStartPrefillToken({ contactId, ttlDays = PREFILL_TTL_DAYS, now = Date.now() }) {
  if (!contactId) throw new Error('signStartPrefillToken: contactId is required')
  const secret = getSecret()
  const exp = Math.floor(now / 1000) + Math.round(ttlDays * 24 * 3600)
  const payload = b64url(JSON.stringify({ c: contactId, e: exp }))
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest())
  return `${payload}.${sig}`
}

/**
 * @param {string} token
 * @param {{now?:number}} [opts]
 * @returns {{contactId:string}|null} null for anything that is not a
 *   well-formed, unexpired token signed under the current secret. One null for
 *   every failure mode on purpose — a caller that could distinguish "expired"
 *   from "forged" would leak whether a given token was ever real.
 */
export function verifyStartPrefillToken(token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token) return null
  const secret = getSecret()
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  if (!payload || !sig) return null
  const expected = b64url(crypto.createHmac('sha256', secret).update(payload).digest())
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  // Length check first: timingSafeEqual THROWS on a length mismatch rather
  // than returning false, and an attacker controls the length.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!obj || typeof obj !== 'object' || !obj.c) return null
    // No expiry claim = a token from before this shipped, or a hand-made one.
    // Refuse it: an unbounded prefill token is the thing the expiry exists to
    // prevent, so "missing" must fail closed, not fall back to forever.
    if (!Number.isFinite(obj.e)) return null
    if (Math.floor(now / 1000) > obj.e) return null
    return { contactId: obj.c }
  } catch {
    return null
  }
}
