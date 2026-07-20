// SUPPORT-ACCESS (Repset Phase 3) — Edge-runtime-safe support-session
// mode cookie + the read-only write-block decision.
//
// src/proxy.js runs on the Edge runtime (no node:crypto), and it is the
// central chokepoint where the READ-ONLY enforcement lives. So the cookie
// sign/verify here uses Web Crypto (crypto.subtle — Edge AND Node 18+
// safe) and this module has NO `next/*` and NO `node:` imports, exactly
// like api-keys-edge.js. The node side (support-session.js, which sets
// cookies + writes the audit table) imports signSupportPayload /
// verifySupportCookie from here so there is ONE signing implementation.
//
// Cookie name:   un1t_support
// Cookie value:  <base64url(json)>.<base64url(hmac_sha256(payloadB64))>
// Payload shape: { sid, org, mode, master, imp, iat, exp }
//   sid    — support_sessions row id
//   org    — target_organization_id (the tenant)
//   mode   — 'read_only' | 'act_on_behalf'
//   master — the master profile id that opened it
//   imp    — impersonated owner profile id, or null (scope-only)
//   iat    — issued-at (ms)
//   exp    — hard expiry (ms) — matches the impersonation cookie max-age
//
// The mode drives the SECURITY CRUX: while a session is read_only, every
// mutating request is rejected at the proxy. The cookie is signed so it
// is TAMPER-EVIDENT — a forged/edited cookie fails verification and is
// treated fail-closed as read_only (writes blocked). A validly-signed
// act_on_behalf cookie is the ONLY thing that lets a write through.

export const SUPPORT_COOKIE = 'un1t_support'

export const SUPPORT_MODES = Object.freeze({
  READ_ONLY: 'read_only',
  ACT_ON_BEHALF: 'act_on_behalf',
})

/** Is this a recognised support mode? */
export function isSupportMode(m) {
  return m === SUPPORT_MODES.READ_ONLY || m === SUPPORT_MODES.ACT_ON_BEHALF
}

// Max wall-clock lifetime of a support session — kept identical to the
// impersonation cookie max-age (IMPERSONATE_SESSION_MAX_AGE_SECONDS) so a
// session that reuses impersonation can't have the two overlays drift out
// of sync (the impersonation cookie dying while the support overlay lives
// would leave a master acting as themselves under a stale support cookie).
export const SUPPORT_SESSION_MAX_AGE_SECONDS = 2 * 60 * 60

// Control routes that must ALWAYS be reachable, even inside a read-only
// session — otherwise a master could get stuck unable to leave or upgrade.
// Kept deliberately tight: only the support-session control surface plus
// the impersonation stop escape-hatch (both strictly REDUCE privilege).
export const SUPPORT_CONTROL_PATHS = Object.freeze([
  '/api/support-session/exit',
  '/api/support-session/switch',
  '/api/impersonate/stop',
])

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// ── base64url (Buffer-free, Edge-safe) ───────────────────────────────
function b64urlFromBytes(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function bytesFromB64url(s) {
  const pad = (4 - (s.length % 4)) % 4
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function b64urlFromString(str) {
  return b64urlFromBytes(new TextEncoder().encode(str))
}
function stringFromB64url(s) {
  return new TextDecoder().decode(bytesFromB64url(s))
}

function getSecret() {
  // Dedicated secret if set, else the service-role key — present in every
  // server/edge env, never exposed to clients. Same fallback shape as
  // studio-session.js. The proxy already reads SUPABASE_SERVICE_ROLE_KEY
  // at the edge, so this is guaranteed available there.
  const secret = process.env.SUPPORT_SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('No SUPPORT_SESSION_SECRET or SUPABASE_SERVICE_ROLE_KEY available')
  return secret
}

async function hmacBytes(payloadB64, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64))
  return new Uint8Array(sig)
}

// Constant-time-ish compare of two b64url signature strings.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

/**
 * Sign a support-session payload into a cookie value. The caller
 * (support-session.js, node) builds the payload; this stamps the HMAC.
 *
 * @param {{sid?:string, org:string, mode:string, master?:string, imp?:string|null, iat?:number, exp?:number}} payload
 * @returns {Promise<string>} cookie value
 */
export async function signSupportPayload(payload) {
  const json = JSON.stringify(payload)
  const payloadB64 = b64urlFromString(json)
  const sig = await hmacBytes(payloadB64, getSecret())
  return `${payloadB64}.${b64urlFromBytes(sig)}`
}

/**
 * Verify + parse a support cookie value. Returns the payload on a good
 * signature, or null when missing / malformed / signed with a different
 * secret. Does NOT check expiry — callers decide how to treat an expired
 * (but validly-signed) cookie.
 *
 * @param {string} cookieValue
 * @returns {Promise<object|null>}
 */
export async function verifySupportCookie(cookieValue) {
  if (typeof cookieValue !== 'string' || !cookieValue.includes('.')) return null
  const [payloadB64, sigB64] = cookieValue.split('.', 2)
  if (!payloadB64 || !sigB64) return null
  let secret
  try {
    secret = getSecret()
  } catch {
    return null
  }
  let expectedB64
  try {
    const sig = await hmacBytes(payloadB64, secret)
    expectedB64 = b64urlFromBytes(sig)
  } catch {
    return null
  }
  if (!safeEqual(expectedB64, sigB64)) return null
  try {
    const payload = JSON.parse(stringFromB64url(payloadB64))
    if (!payload || typeof payload.org !== 'string') return null
    return payload
  } catch {
    return null
  }
}

/**
 * Resolve the support-session state for an incoming request, FAIL-CLOSED.
 *
 *   - no cookie                      → { active: false }
 *   - cookie present, bad signature  → { active: true, mode: read_only }  (FAIL CLOSED)
 *   - cookie present, valid, expired → { active: false }  (overlay is over — don't block the master's own writes)
 *   - cookie present, valid, live    → { active: true, mode }  (mode read_only unless EXACTLY act_on_behalf)
 *
 * A present-but-unverifiable cookie is deliberately collapsed to
 * read_only so a tampered/corrupt cookie blocks writes rather than
 * silently granting them.
 *
 * @param {{cookies?: {get?: Function}}} request  a NextRequest-shaped object
 * @param {number} [now]  epoch ms (injectable for tests)
 * @returns {Promise<{active:boolean, mode:string|null, org?:string|null, sid?:string|null, master?:string|null, reason?:string}>}
 */
export async function readSupportModeEdge(request, now = Date.now()) {
  let raw = null
  try {
    raw = request?.cookies?.get?.(SUPPORT_COOKIE)?.value || null
  } catch {
    raw = null
  }
  if (!raw) return { active: false, mode: null }

  const payload = await verifySupportCookie(raw)
  if (!payload) {
    // Present but unverifiable → FAIL CLOSED.
    return { active: true, mode: SUPPORT_MODES.READ_ONLY, reason: 'unverified' }
  }
  if (typeof payload.exp === 'number' && now > payload.exp) {
    // Validly-signed but past its max-age: the impersonation cookie has
    // expired too, so the master is themselves again — treat the overlay
    // as gone and do NOT block their own writes. The stale-close reaper
    // stamps ended_at on the audit row.
    return { active: false, mode: null, reason: 'expired' }
  }
  const mode = payload.mode === SUPPORT_MODES.ACT_ON_BEHALF
    ? SUPPORT_MODES.ACT_ON_BEHALF
    : SUPPORT_MODES.READ_ONLY // unknown/garbled mode → read_only (fail closed)
  return { active: true, mode, org: payload.org || null, sid: payload.sid || null, master: payload.master || null }
}

/**
 * THE SECURITY CRUX — pure decision. Given the resolved support state and
 * the request's method + path, decide whether to BLOCK a state-changing
 * request. Exported (and unit-tested) so the proxy's rule is provable in
 * isolation.
 *
 * Rules, in order:
 *   1. No active support session          → allow (normal traffic).
 *   2. Safe method (GET/HEAD/OPTIONS)      → allow (reads are always fine).
 *   3. Mode EXACTLY act_on_behalf          → allow (writes scoped by impersonation).
 *   4. Control route (exit / switch / stop)→ allow (must be able to leave/upgrade).
 *   5. Otherwise                           → BLOCK (fail closed).
 *
 * Note the ordering of 3: a write is permitted ONLY when the mode is
 * EXPLICITLY 'act_on_behalf'. Any other value (read_only, unknown,
 * undefined) falls through to the block. That is what makes this
 * fail-closed — ambiguity blocks the write.
 *
 * @param {{active?:boolean, mode?:string|null}} support
 * @param {string} method
 * @param {string} pathname
 * @returns {{block:boolean, reason?:string}}
 */
export function decideSupportWriteBlock(support, method, pathname) {
  if (!support || !support.active) return { block: false }
  const m = String(method || 'GET').toUpperCase()
  if (SAFE_METHODS.has(m)) return { block: false }
  if (support.mode === SUPPORT_MODES.ACT_ON_BEHALF) return { block: false }
  const path = pathname || ''
  const isControl = SUPPORT_CONTROL_PATHS.some((p) => path === p || path.startsWith(p))
  if (isControl) return { block: false }
  return { block: true, reason: 'read_only_support_mode' }
}
