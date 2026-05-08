// Bridge authentication.
//
// BLE bridges (Pi devices running champ-bridge) authenticate with a
// bearer token. The raw token is generated server-side at bridge
// creation, shown to the operator exactly once, and never persisted.
// Only the SHA-256 hash is stored in ble_bridges.api_token_hash.
//
// SHA-256 not bcrypt
// ------------------
// Tokens are sent on every /api/bridge/* request — a class with
// 30 straps generates a heartbeat + samples ~every second. Bcrypt
// at the default cost would add 100+ms per request and serialise
// the API behind itself. SHA-256 of a 32-byte random token is
// uncrackable from a DB dump (no rainbow table for 256 bits of
// entropy), so the slowness premium isn't justified.
//
// Token shape
// -----------
// 32 random bytes, base64url-encoded → 43 chars. Prefix with `bbr_`
// so a leaked token in a log is obviously a bridge token (matches
// the Stripe / Postmark prefix pattern).
//
// Rotation
// --------
// Operator can rotate any bridge's token. The route updates the
// hash; the bridge software either reloads its config and reconnects,
// or stops authenticating until reflashed. We don't keep prior
// hashes — rotation is "the previous token is dead immediately".

import { createHash, randomBytes } from 'node:crypto'
import { createServerClient } from '@/lib/supabase'

const TOKEN_PREFIX = 'bbr_'

/**
 * Generate a fresh raw token + its sha256 hash. Returns BOTH —
 * the raw value is never stored. The caller persists the hash and
 * must surface the raw value to the operator before the response
 * is GC'd.
 *
 * @returns {{ raw: string, hash: string }}
 */
export function issueBridgeToken() {
  const raw = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const hash = sha256Hex(raw)
  return { raw, hash }
}

/**
 * Hash a raw token (sha256 hex). Exported so admin rotation can
 * verify a typed-out token before saving it (rare flow — rotation
 * usually generates a new one).
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * Verify an incoming bearer token and return the bridge it
 * authenticates as. Returns null if the header is malformed,
 * the token doesn't match a known bridge, or the bridge row was
 * deleted between the bridge's last sync and this request.
 *
 * The caller should treat null as 401 unauthorised. We deliberately
 * don't differentiate "missing header" from "wrong token" in the
 * response — both are 401, and tighter error info just helps an
 * attacker enumerate.
 *
 * @param {Request|Headers|string} requestOrHeaderValue
 *        A Request, Headers, or the raw "Bearer xxx" string.
 * @returns {Promise<{
 *   bridgeId: string,
 *   locationId: string,
 *   hardwareId: string,
 *   name: string,
 *   status: string,
 * }|null>}
 */
export async function verifyBridgeToken(requestOrHeaderValue) {
  const raw = parseBearer(requestOrHeaderValue)
  if (!raw) return null
  const hash = sha256Hex(raw)
  const db = createServerClient()
  const { data, error } = await db
    .from('ble_bridges')
    .select('id, location_id, hardware_id, name, status')
    .eq('api_token_hash', hash)
    .maybeSingle()
  if (error || !data) return null
  return {
    bridgeId: data.id,
    locationId: data.location_id,
    hardwareId: data.hardware_id,
    name: data.name,
    status: data.status,
  }
}

// ── internals ────────────────────────────────────────────────────

function parseBearer(input) {
  let header = null
  if (typeof input === 'string') {
    header = input
  } else if (input && typeof input.get === 'function') {
    // Headers-like (Request.headers, Headers)
    header = input.get('authorization') || input.get('Authorization')
  } else if (input && input.headers && typeof input.headers.get === 'function') {
    // Request
    header = input.headers.get('authorization') || input.headers.get('Authorization')
  }
  if (!header) return null
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header)
  if (!m) return null
  // Reject tokens that obviously aren't ours — micro-defence against
  // a misrouted Authorization header from another integration.
  if (!m[1].startsWith(TOKEN_PREFIX)) return null
  return m[1]
}
