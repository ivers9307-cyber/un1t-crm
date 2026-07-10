// Per-host unsubscribe tokens (HOST-EMAIL.2). Every host campaign email
// footer links /unsubscribe/host/[token]; the token pins WHICH contact is
// unsubscribing from WHICH host, so the landing page can upsert a
// host_email_suppressions row with no login and no query params to tamper
// with. Suppression is per-host by design — UN1T marketing and other hosts'
// lists are untouched (the global gate stays contacts.email_marketing).
//
// Stateless HMAC-SHA256 keyed on SUPABASE_SERVICE_ROLE_KEY (already secret,
// already present in every server environment) — mirrors signCheckinToken
// (event-checkin-tokens.js). Server-only (node:crypto): never import from a
// client component.

import crypto from 'node:crypto'

const b64url = (input) => Buffer.from(input).toString('base64url')

function getSecret() {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set — cannot sign or verify host unsubscribe tokens.')
  }
  return secret
}

/**
 * @param {{hostId:string, contactId:string}} ids
 * @returns {string} `${payload}.${sig}` (both base64url — URL-safe as-is)
 */
export function signHostUnsubToken({ hostId, contactId }) {
  const secret = getSecret()
  const payload = b64url(JSON.stringify({ h: hostId, c: contactId }))
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest())
  return `${payload}.${sig}`
}

/**
 * @param {string} token
 * @returns {{hostId:string, contactId:string}|null} null for anything that
 *   isn't a well-formed token signed under the current secret
 */
export function verifyHostUnsubToken(token) {
  const secret = getSecret()
  if (typeof token !== 'string' || !token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  if (!payload || !sig) return null
  const expected = b64url(crypto.createHmac('sha256', secret).update(payload).digest())
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!obj || typeof obj !== 'object' || !obj.h || !obj.c) return null
    return { hostId: obj.h, contactId: obj.c }
  } catch {
    return null
  }
}
