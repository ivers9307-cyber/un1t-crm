// SAAS-3 — Edge-runtime-safe helpers for per-org API keys.
//
// src/proxy.js runs on the Edge runtime, where node:crypto is
// unavailable — it must not import api-keys.js. The SHA-256 here uses
// Web Crypto (crypto.subtle, available on Edge AND Node 18+) and MUST
// produce byte-identical output to hashApiKey() in api-keys.js: the
// proxy hashes the presented bearer token and looks it up against
// api_keys.key_hash rows that were written by the Node side.
// Cross-checked in api-keys-edge.test.js.
//
// api-keys.js re-exports API_KEY_PREFIX / isApiKeyToken from here, so
// this file is the single source of truth for the token format.
// No node: imports allowed in this file.

export const API_KEY_PREFIX = 'unitk_'

/** Does this bearer token look like a per-org API key (vs the legacy shared secret)? */
export function isApiKeyToken(token) {
  return typeof token === 'string' && token.startsWith(API_KEY_PREFIX)
}

/** SHA-256 hex of the full raw key — Web Crypto twin of hashApiKey(). */
export async function sha256HexEdge(raw) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(raw)))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
