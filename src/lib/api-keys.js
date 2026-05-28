// APIKEYS.1 — pure helpers for per-organization API keys.
//
// Key shape: `unitk_` + 40 hex chars. We store only a display prefix
// (`unitk_` + first 8 chars) and the SHA-256 hash of the full key; the
// raw key is shown to the operator exactly once at creation. Auth looks
// a key up by its hash (high-entropy, unique-indexed) — no plaintext is
// ever stored or compared.
//
// These functions are pure (deterministic hash, format helpers) so they
// unit-test under the Node env. The DB lookup lives in api-auth.js.

import { createHash, randomBytes } from 'node:crypto'

export const API_KEY_PREFIX = 'unitk_'
// Display prefix = 'unitk_' + 8 chars of the secret.
export const API_KEY_DISPLAY_LEN = API_KEY_PREFIX.length + 8

/** SHA-256 hex of the full raw key. Deterministic. */
export function hashApiKey(raw) {
  return createHash('sha256').update(String(raw)).digest('hex')
}

/** Does this bearer token look like a per-org API key (vs the legacy shared secret)? */
export function isApiKeyToken(token) {
  return typeof token === 'string' && token.startsWith(API_KEY_PREFIX)
}

/** The display/identification prefix for a full key (safe to store + show). */
export function apiKeyDisplayPrefix(full) {
  return String(full).slice(0, API_KEY_DISPLAY_LEN)
}

/**
 * Mint a new key. Returns the raw `full` key (show once, never stored),
 * the `prefix` (stored for display), and the `hash` (stored for lookup).
 */
export function generateApiKey() {
  const secret = randomBytes(20).toString('hex') // 40 hex chars
  const full = `${API_KEY_PREFIX}${secret}`
  return { full, prefix: apiKeyDisplayPrefix(full), hash: hashApiKey(full) }
}
