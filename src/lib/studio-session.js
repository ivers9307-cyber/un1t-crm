// STUDIO-PIN.3 — studio_session signed cookie.
//
// PIN-login on a paired studio device (Mac shell, iPad) mints a
// signed cookie that proves the request came from a successful PIN
// unlock on that device. The cookie carries the staffer's profile id
// + the device id + an idle timestamp; auth.js recognises it as a
// third auth source alongside Supabase Bearer (mobile) and the
// Supabase SSR session cookie (web).
//
// We use a plain HMAC-signed JSON envelope rather than a full JWT
// library — the cookie never travels off-server (set by us, read by
// us) and we want zero new deps. Format:
//
//   <base64url(json)>.<base64url(hmac_sha256(base64url(json), SECRET))>
//
// Payload shape:
//
//   {
//     sub:      <profile id>,
//     dev:      <studio_devices.id>,
//     loc:      <location_id>,
//     iat:      <issued-at ms>,
//     exp:      <hard expiry ms>,
//     last_act: <last-activity ms — refreshed on every authenticated request>
//   }
//
// `exp` is a generous ceiling (default 8h). `last_act` is the
// 5-minute idle gate that ACTUALLY matters — the cookie is treated as
// locked if (now - last_act) > IDLE_TIMEOUT_MS.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { logWarn } from './log.js'

export const COOKIE_NAME = 'studio_session'
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000        // 5 minutes
export const ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000    // 8 hours

function getSecret() {
  // Fall back to the service-role key — present in every server-side
  // env, never exposed to clients. Better than crashing in environments
  // where STUDIO_SESSION_SECRET isn't set explicitly.
  const explicit = process.env.STUDIO_SESSION_SECRET
  const fallback = process.env.SUPABASE_SERVICE_ROLE_KEY
  const secret = explicit || fallback
  if (!secret) {
    throw new Error('No STUDIO_SESSION_SECRET or SUPABASE_SERVICE_ROLE_KEY available')
  }
  return secret
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url')
}
function b64urlDecode(s) {
  return Buffer.from(s, 'base64url')
}

function sign(payloadB64, secret) {
  return createHmac('sha256', secret).update(payloadB64, 'utf8').digest()
}

/**
 * Mint a fresh studio_session cookie value.
 *
 * @param {object} args
 * @param {string} args.profileId  — uuid
 * @param {string} args.deviceId   — uuid
 * @param {string} args.locationId — uuid
 * @param {number} [args.now]      — clock injection for tests
 * @returns {string} cookie value
 */
export function mintStudioSession({ profileId, deviceId, locationId, now = Date.now() }) {
  if (!profileId || !deviceId || !locationId) {
    throw new Error('mintStudioSession: profileId, deviceId, locationId all required')
  }
  const payload = {
    sub: profileId,
    dev: deviceId,
    loc: locationId,
    iat: now,
    exp: now + ABSOLUTE_TTL_MS,
    last_act: now,
  }
  const json = JSON.stringify(payload)
  const payloadB64 = b64urlEncode(json)
  const sig = sign(payloadB64, getSecret())
  return `${payloadB64}.${b64urlEncode(sig)}`
}

/**
 * Validate + parse a studio_session cookie. Returns the payload on
 * success, or null when the cookie is missing / malformed / signed
 * with a different secret / expired / idle-locked.
 *
 * Idle-locked vs expired: both return null. Callers that need to
 * differentiate (e.g. "show a re-PIN screen vs a full login screen")
 * can call `inspectStudioSession` instead.
 */
export function readStudioSession(cookieValue, { now = Date.now() } = {}) {
  const inspect = inspectStudioSession(cookieValue, { now })
  return inspect.status === 'active' ? inspect.payload : null
}

/**
 * Like readStudioSession but returns a status enum so callers can
 * route on the failure mode. Status values:
 *   'active'         — signature good, exp + last_act fresh
 *   'idle_locked'    — signature good, exp fresh, last_act stale (> 5 min)
 *   'expired'        — signature good, exp passed (hard expiry)
 *   'invalid'        — missing, malformed, or signature mismatch
 */
export function inspectStudioSession(cookieValue, { now = Date.now() } = {}) {
  if (typeof cookieValue !== 'string' || !cookieValue.includes('.')) {
    return { status: 'invalid' }
  }
  const [payloadB64, sigB64] = cookieValue.split('.', 2)
  if (!payloadB64 || !sigB64) return { status: 'invalid' }

  let secret
  try {
    secret = getSecret()
  } catch (e) {
    logWarn('studio-session', 'secret unavailable', { err: e?.message })
    return { status: 'invalid' }
  }

  let expectedSig, gotSig
  try {
    expectedSig = sign(payloadB64, secret)
    gotSig = b64urlDecode(sigB64)
  } catch {
    return { status: 'invalid' }
  }
  if (expectedSig.length !== gotSig.length) return { status: 'invalid' }
  if (!timingSafeEqual(expectedSig, gotSig)) return { status: 'invalid' }

  let payload
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'))
  } catch {
    return { status: 'invalid' }
  }

  if (typeof payload?.sub !== 'string' || typeof payload?.dev !== 'string' ||
      typeof payload?.exp !== 'number' || typeof payload?.last_act !== 'number') {
    return { status: 'invalid' }
  }

  if (now > payload.exp) return { status: 'expired', payload }
  if (now - payload.last_act > IDLE_TIMEOUT_MS) {
    return { status: 'idle_locked', payload }
  }
  return { status: 'active', payload }
}

/**
 * Take an existing valid (or idle-locked) cookie and produce a fresh
 * one with `last_act` bumped to `now`. Preserves the original `iat`,
 * `exp`, `sub`, `dev`, `loc`. Returns null when the input is invalid
 * or hard-expired (idle-locked cookies CAN be refreshed when paired
 * with a fresh PIN re-entry; expired cannot).
 */
export function refreshStudioSession(cookieValue, { now = Date.now(), refreshIdleLocked = false } = {}) {
  const inspect = inspectStudioSession(cookieValue, { now })
  if (inspect.status === 'invalid' || inspect.status === 'expired') return null
  if (inspect.status === 'idle_locked' && !refreshIdleLocked) return null

  const payload = { ...inspect.payload, last_act: now }
  const json = JSON.stringify(payload)
  const payloadB64 = b64urlEncode(json)
  const sig = sign(payloadB64, getSecret())
  return `${payloadB64}.${b64urlEncode(sig)}`
}

/**
 * Cookie-attribute string for Set-Cookie. Same value used at mint and
 * refresh so callers don't have to remember the flags.
 *
 * - HttpOnly       — JS can't read it; server-side only.
 * - Secure         — sent only over HTTPS in prod.
 * - SameSite=Lax   — leaks across same-site navigations (fine for us)
 *                    but not cross-site, which matters for CSRF.
 * - Path=/         — entire app.
 * - Max-Age in seconds tied to ABSOLUTE_TTL_MS.
 */
export function cookieAttributes({ secure = process.env.NODE_ENV === 'production' } = {}) {
  const flags = [
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${Math.floor(ABSOLUTE_TTL_MS / 1000)}`,
  ]
  if (secure) flags.push('Secure')
  return flags.join('; ')
}
