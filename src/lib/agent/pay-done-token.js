// MIAHATCH.6 — the pay-done token (spec 6.5.2), a leaf module: node:crypto
// only, so the public /pay-done page can hash a token without importing
// purchase-intents (and with it the un1t write-ops graph).
//
// The token is 32 random bytes, base64url (always 43 chars of [A-Za-z0-9_-]),
// carried in the hosted checkout's success and cancel URLs. Only its sha256
// hex is stored on mia_purchase_intents.
import { createHash, randomBytes } from 'node:crypto'

/** What a token minted here always looks like (32 bytes as base64url). */
export const PAY_DONE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

/** sha256 hex of a pay-done token (what the intent stores). Pure. */
export function hashPayDoneToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

/** A fresh pay-done token (32 random bytes, base64url) and its hash. */
export function mintPayDoneToken() {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashPayDoneToken(token) }
}
