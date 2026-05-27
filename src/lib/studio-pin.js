// STUDIO-PIN.1 — PIN hashing + verification for studio-device auth.
//
// Studio devices (Mac shell, paired iPads) log staff in with a 4-digit
// PIN instead of email + password. The PIN itself globally identifies
// the staffer at login (PIN-alone-identifies-staffer model — see the
// design doc), so the value of hashing is purely defence-in-depth
// against an offline brute force IF the profiles.pin_hash column ever
// leaks. A 4-digit search space is trivially crackable at any cost
// factor on modern hardware, so the hash strength matters mostly for
// "make leaks expensive to use", not "make brute force impossible."
//
// Uses Node's built-in scrypt (no new dependency). Standard scrypt
// cost (N=16384, r=8, p=1) takes ~50ms per verify — fine for an
// interactive unlock flow, but callers MUST NOT loop verifyPin across
// every profile without rate-limiting. In practice we don't need to —
// the global-uniqueness UNIQUE constraint on pin_hash means we can't
// look up by PIN directly, so the matcher iterates profiles with a
// pin_hash set in a single hot loop. That's why this lib is exported
// alongside `findProfileByPin` which encapsulates the iteration and
// imposes a hard cap (see findProfileByPin docstring).
//
// Hash format: `scrypt$<saltHex>$<derivedKeyHex>`. 16-byte salt, 32-
// byte derived key. Different format from password_hash (which uses
// Supabase Auth's bcrypt under the hood) — these PINs live alongside
// the full email + password creds in different columns.

import { scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)

const KEY_LEN = 32
const SALT_LEN = 16

const PIN_RE = /^\d{4}$/

/**
 * Strict format check. Used at the API boundary before hashing or
 * matching so we surface a clean 400 rather than letting weird input
 * silently fail-to-match.
 */
export function isValidPinFormat(pin) {
  return typeof pin === 'string' && PIN_RE.test(pin)
}

/**
 * Hash a 4-digit PIN. Throws on bad format so the caller can return
 * a clean 400 rather than persist garbage.
 *
 * @param {string} pin — must be exactly 4 digits, '0000' through '9999'
 * @returns {Promise<string>} — formatted hash, suitable for
 *   profiles.pin_hash
 */
export async function hashPin(pin) {
  if (!isValidPinFormat(pin)) {
    throw new Error('PIN must be exactly 4 digits')
  }
  const salt = randomBytes(SALT_LEN)
  const dk = await scrypt(pin, salt, KEY_LEN)
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`
}

/**
 * Verify a PIN against a stored hash. Returns false (rather than
 * throwing) on every form of malformed input — the caller should
 * treat a false return as "no match" without distinguishing between
 * "wrong PIN" and "corrupt hash". Constant-time comparison via
 * timingSafeEqual.
 *
 * @param {string} pin — must be exactly 4 digits
 * @param {string} hash — value from profiles.pin_hash
 * @returns {Promise<boolean>}
 */
export async function verifyPin(pin, hash) {
  if (!isValidPinFormat(pin)) return false
  if (typeof hash !== 'string') return false

  const parts = hash.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false

  let salt
  let expected
  try {
    salt = Buffer.from(parts[1], 'hex')
    expected = Buffer.from(parts[2], 'hex')
  } catch {
    return false
  }
  if (salt.length !== SALT_LEN || expected.length !== KEY_LEN) return false

  let dk
  try {
    dk = await scrypt(pin, salt, KEY_LEN)
  } catch {
    return false
  }

  // timingSafeEqual requires same-length buffers; we just verified
  // both are KEY_LEN, so this is safe.
  return timingSafeEqual(dk, expected)
}

/**
 * Find the profile whose pin_hash matches the supplied PIN. Iterates
 * profiles with a non-null pin_hash and runs verifyPin against each
 * until a match (or exhaustion). Because pin_hash has a UNIQUE
 * constraint, at most one profile can match.
 *
 * The iteration is the price we pay for hashing PINs at all — we
 * can't do an indexed lookup by hash because each hash uses a fresh
 * salt. With ~50 staff at the upper end and ~50ms per scrypt verify,
 * a worst-case match takes ~2.5s. For studio-device PIN entry that's
 * acceptable but worth knowing about; the per-device rate-limit
 * means a brute-forcer doesn't get the benefit either.
 *
 * Refuses to run if more than `safetyCap` profiles have a PIN set —
 * defence against an outright misconfiguration where every staffer
 * including former employees has a live PIN.
 *
 * @param {object} args
 * @param {object} args.db           — service-role Supabase client
 * @param {string} args.pin          — 4 digits
 * @param {number} [args.safetyCap]  — max profiles to consider; default 200
 * @returns {Promise<{id: string, full_name: string} | null>}
 */
export async function findProfileByPin({ db, pin, safetyCap = 200 }) {
  if (!isValidPinFormat(pin)) return null

  const { data: candidates, error } = await db
    .from('profiles')
    .select('id, full_name, pin_hash')
    .not('pin_hash', 'is', null)
    .eq('active', true)
    .limit(safetyCap + 1)

  if (error) throw new Error(error.message)
  if (!candidates || candidates.length === 0) return null
  if (candidates.length > safetyCap) {
    throw new Error(
      `findProfileByPin: more than ${safetyCap} profiles have a PIN set — refusing to scan. Check for stale PINs on deactivated profiles.`,
    )
  }

  for (const p of candidates) {
    if (await verifyPin(pin, p.pin_hash)) {
      return { id: p.id, full_name: p.full_name }
    }
  }
  return null
}
