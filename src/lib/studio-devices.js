// STUDIO-PIN.1 — paired-device token + per-device lockout helpers.
//
// Studio devices (Mac shell, paired iPads) are explicitly paired by a
// master from /admin/studio-devices. Pairing generates a 256-bit
// random token; the device stores the cleartext in Keychain / Secure
// Store, the server persists only the sha256 hash. Every PIN-login
// request carries the token; the server hash-matches.
//
// Tokens are high-entropy (~256 bits) so a slow KDF for hashing is
// over-engineering — sha256 + constant-time compare is sufficient
// and saves ~50ms per request (PIN verification already does ~50ms
// of scrypt). PINs use scrypt (see studio-pin.js); tokens use sha256.
//
// Lockout is per-device, not per-staffer. Under the
// PIN-alone-identifies-staffer model a wrong PIN doesn't tell us
// which staffer to penalise, so the only counter that makes sense is
// "this physical device". We count wrong_pin rows in pin_login_attempts
// in the last 15 minutes; at >= 5, the device is locked for 15 more
// minutes from the most recent attempt.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_BYTES = 32
const LOCKOUT_THRESHOLD = 5
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000

/**
 * Generate a fresh device-pairing token. Returns the cleartext (to
 * hand to the device) and the hash (to persist in
 * studio_devices.device_token_hash).
 *
 * The cleartext token MUST be transmitted to the device exactly once
 * (in the pairing API response) and never persisted server-side.
 */
export function generateDeviceToken() {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  return { token, hash: hashDeviceToken(token) }
}

/**
 * Hash a device token for storage / comparison. Plain sha256 — see
 * the file-level comment for the rationale.
 */
export function hashDeviceToken(token) {
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('device token must be a non-empty string')
  }
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Constant-time hash-compare. The hashes are equal-length hex
 * strings; we still wrap timingSafeEqual to keep the security
 * property explicit in the call site.
 */
export function deviceTokenMatches(token, storedHash) {
  if (typeof token !== 'string' || typeof storedHash !== 'string') return false
  let actual
  try {
    actual = createHash('sha256').update(token, 'utf8').digest()
  } catch {
    return false
  }
  let expected
  try {
    expected = Buffer.from(storedHash, 'hex')
  } catch {
    return false
  }
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

/**
 * Look up a paired device by token. Returns the device row on match,
 * null on no-match or revoked. Caller is responsible for deciding
 * what to do about lockout state — see getDeviceLockoutState below.
 *
 * Pulls all active devices and hash-compares in-memory. The active
 * device count is small (a handful per studio) so a linear scan is
 * cheaper than maintaining an index on the hash.
 *
 * @param {object} args
 * @param {object} args.db       — service-role Supabase client
 * @param {string} args.token    — cleartext token from the request
 * @returns {Promise<object | null>} — the studio_devices row, or null
 */
export async function findDeviceByToken({ db, token }) {
  if (typeof token !== 'string' || token.length < 16) return null

  const { data: devices, error } = await db
    .from('studio_devices')
    .select('*')
    .is('revoked_at', null)

  if (error) throw new Error(error.message)
  if (!devices || devices.length === 0) return null

  for (const d of devices) {
    if (deviceTokenMatches(token, d.device_token_hash)) {
      return d
    }
  }
  return null
}

/**
 * Determine whether a device is currently locked out. Counts
 * `wrong_pin` rows in pin_login_attempts for the device in the last
 * 15 minutes; at >= LOCKOUT_THRESHOLD the device is locked until 15
 * minutes after the most recent wrong attempt.
 *
 * Returns:
 *   - { locked: false, recentFailures: number } when below threshold
 *   - { locked: true,  recentFailures: number, retryAfter: ISO date }
 *     when at or above threshold
 *
 * @param {object} args
 * @param {object} args.db        — service-role Supabase client
 * @param {string} args.deviceId  — studio_devices.id
 * @param {Date}   [args.now]     — clock injection for tests
 */
export async function getDeviceLockoutState({ db, deviceId, now = new Date() }) {
  const since = new Date(now.getTime() - LOCKOUT_WINDOW_MS).toISOString()

  const { data: rows, error } = await db
    .from('pin_login_attempts')
    .select('attempted_at')
    .eq('device_id', deviceId)
    .eq('outcome', 'wrong_pin')
    .gte('attempted_at', since)
    .order('attempted_at', { ascending: false })

  if (error) throw new Error(error.message)
  const recentFailures = (rows || []).length

  if (recentFailures < LOCKOUT_THRESHOLD) {
    return { locked: false, recentFailures }
  }

  // Lockout runs from the most recent failure (not the oldest in the
  // window) — so 5 fast wrong PINs lock for 15 min from the last one,
  // not from the first.
  const latestAttemptIso = rows[0].attempted_at
  const retryAfter = new Date(
    new Date(latestAttemptIso).getTime() + LOCKOUT_WINDOW_MS,
  ).toISOString()

  return { locked: true, recentFailures, retryAfter }
}

/**
 * Constants exported for tests + downstream callers that want to
 * surface the lockout policy in UI copy without hard-coding numbers.
 */
export const STUDIO_LOCKOUT = Object.freeze({
  threshold: LOCKOUT_THRESHOLD,
  windowMs: LOCKOUT_WINDOW_MS,
})
