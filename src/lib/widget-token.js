// src/lib/widget-token.js
// WIDGET.1 — the widget credential's shape, in one place.
//
// The `rwt_` prefix is load-bearing, not cosmetic. It is what lets
// parseWidgetBearer tell a widget token from a Supabase JWT on the SAME
// Authorization header, so a widget token presented to a route that did not
// opt in falls through to normal JWT verification and 401s, rather than
// being mistaken for a session.

import { createHash, randomBytes } from 'node:crypto'

export const WIDGET_TOKEN_PREFIX = 'rwt_'

const BEARER_RE = /^Bearer\s+(\S+)$/i

/** Mint a new plaintext token. Returned to the device ONCE and never stored. */
export function generateWidgetToken() {
  return WIDGET_TOKEN_PREFIX + randomBytes(32).toString('base64url')
}

/**
 * sha256 of a widget token, or null if it is not one.
 * Plain sha256 with no salt is correct here: the input is 256 bits of CSPRNG
 * output, so there is no dictionary to stretch against — this is a lookup
 * key, not a password hash.
 */
export function hashWidgetToken(token) {
  if (typeof token !== 'string') return null
  if (!token.startsWith(WIDGET_TOKEN_PREFIX)) return null
  if (token.length <= WIDGET_TOKEN_PREFIX.length) return null
  return createHash('sha256').update(token).digest('hex')
}

/** Pull a widget token out of an Authorization header. Null for anything else. */
export function parseWidgetBearer(header) {
  if (typeof header !== 'string') return null
  const m = header.trim().match(BEARER_RE)
  if (!m) return null
  return m[1].startsWith(WIDGET_TOKEN_PREFIX) ? m[1] : null
}
