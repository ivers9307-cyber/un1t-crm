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
// Rotation (grace window)
// -----------------------
// Operator can rotate any bridge's token. To avoid a hard mid-day cut
// (which took live HR ingest down until the Pi was reflashed, and so
// discouraged rotation entirely), rotation is dual-token: the route
// moves the current hash into previous_token_hash with an expiry of
// now() + TOKEN_GRACE_MS, and installs the new hash as api_token_hash.
// The OLD token keeps authenticating until previous_token_expires_at,
// giving the operator a window to update the Pi with zero downtime.
//
// Decommissioning
// ---------------
// A bridge whose row survives but whose status is 'decommissioned' is
// refused here — a retired Pi must not keep authenticating just because
// its row (and token hash) still exists (security audit L2).

import { createHash, randomBytes } from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp } from '@/lib/rate-limit'

const TOKEN_PREFIX = 'bbr_'

// Failed-auth limiter (audit H2): counted ONLY on FAILED token verification,
// so the success hot path (a live class heartbeats + samples every ~2s) pays
// ZERO extra RPCs. 20 failures / 15 min per IP is far above anything a
// mis-provisioned Pi produces while making unlimited token guessing loud and
// slow. Fail-open like the rest of rate-limit.js — a limiter outage must
// never take live HR ingest down.
export const AUTH_FAIL_LIMIT = { max: 20, windowMs: 15 * 60_000 }

// Rotation grace window: how long the PREVIOUS token keeps authenticating
// after a rotation, so live HR ingest doesn't drop while the Pi is updated.
export const TOKEN_GRACE_MS = 24 * 60 * 60 * 1000 // 24h

// Statuses that are NOT allowed to authenticate. 'online'/'offline'/'error'
// are all live states a working bridge passes through; only an operator-set
// terminal state blocks auth.
const BLOCKED_STATUSES = new Set(['decommissioned'])

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
 * Every failure path records a per-IP hit against AUTH_FAIL_LIMIT
 * (see rejectAuthFailure) so brute-force guessing is rate-tracked;
 * a SUCCESSFUL verification never touches the limiter.
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
  if (!raw) return rejectAuthFailure(requestOrHeaderValue)
  const hash = sha256Hex(raw)
  const db = createServerClient()
  // Match either the current token OR the grace-window previous token. The
  // hash is 64 hex chars (no PostgREST-filter metacharacters), so it is safe
  // to interpolate into the .or() filter. Callers treat any non-object return
  // as 401 and never wrap this in try/catch, so we own error handling here —
  // a builder throw (e.g. maybeSingle seeing >1 row, impossible with 256-bit
  // tokens but cheap to guard) resolves to null, not a 500.
  let data, error
  try {
    ;({ data, error } = await db
      .from('ble_bridges')
      .select('id, location_id, hardware_id, name, status, api_token_hash, previous_token_hash, previous_token_expires_at')
      .or(`api_token_hash.eq.${hash},previous_token_hash.eq.${hash}`)
      .maybeSingle())
  } catch {
    return rejectAuthFailure(requestOrHeaderValue, db)
  }
  if (error || !data) return rejectAuthFailure(requestOrHeaderValue, db)

  // A retired bridge must not authenticate even though its row (and hash)
  // survive (security audit L2).
  if (BLOCKED_STATUSES.has(data.status)) return rejectAuthFailure(requestOrHeaderValue, db)

  // If the match was on the current token, accept. Otherwise it matched the
  // previous token — accept only inside the grace window.
  const currentMatch = data.api_token_hash === hash
  if (!currentMatch) {
    const expiresAt = data.previous_token_expires_at
      ? new Date(data.previous_token_expires_at).getTime()
      : 0
    if (!(expiresAt > Date.now())) return rejectAuthFailure(requestOrHeaderValue, db)
  }

  return {
    bridgeId: data.id,
    locationId: data.location_id,
    hardwareId: data.hardware_id,
    name: data.name,
    status: data.status,
  }
}

// ── internals ────────────────────────────────────────────────────

/**
 * Record one failed-auth hit for the caller's IP and return null (the
 * uniform 401 sentinel every failure path already returns). The hit is
 * fixed-window counted per IP via rate_limit_hit; when an IP is over
 * AUTH_FAIL_LIMIT the attempt is rejected (it already is — verification
 * failed) and we log so a guessing spree is visible in Vercel logs.
 *
 * Only Request/Headers inputs carry network context; a raw header-string
 * caller has no IP to key on, so nothing is recorded. Fail-open: a limiter
 * error never changes the outcome (still null) and never throws.
 */
async function rejectAuthFailure(input, db = null) {
  try {
    const ip = clientIpFrom(input)
    if (!ip) return null
    const result = await checkRateLimit(db || createServerClient(), `bridge-auth-fail:${ip}`, AUTH_FAIL_LIMIT)
    if (!result.allowed) {
      console.warn(`[bridge-auth] failed-auth rate limit exceeded for ${ip} (${AUTH_FAIL_LIMIT.max}/${AUTH_FAIL_LIMIT.windowMs}ms)`)
    }
  } catch (err) {
    // Fail open — the request is already rejected; the limiter must never 500.
    console.error('[bridge-auth] failure-limiter error (ignored):', err?.message || err)
  }
  return null
}

/** Client IP from a Request or Headers input; null for raw header strings. */
function clientIpFrom(input) {
  if (input && input.headers && typeof input.headers.get === 'function') {
    return getClientIp(input) // Request
  }
  if (input && typeof input.get === 'function') {
    return getClientIp({ headers: input }) // Headers
  }
  return null
}

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
