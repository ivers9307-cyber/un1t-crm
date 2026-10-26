// STUDIO-PIN.1 — PIN hashing + verification for studio-device auth.
//
// Studio devices (Mac shell, paired iPads) log staff in with a 4-digit
// PIN instead of email + password. The PIN alone identifies the staffer
// among the people who can work at the device's studio (PINSCOPE.1,
// below), so the value of hashing is purely defence-in-depth
// against an offline brute force IF the profiles.pin_hash column ever
// leaks. A 4-digit search space is trivially crackable at any cost
// factor on modern hardware, so the hash strength matters mostly for
// "make leaks expensive to use", not "make brute force impossible."
//
// Uses Node's built-in scrypt (no new dependency). Standard scrypt
// cost (N=16384, r=8, p=1) takes ~50ms per verify — fine for an
// interactive unlock flow, but callers MUST NOT loop verifyPin across
// every profile without rate-limiting. Per-salt hashes mean we can't
// look up by PIN directly, so the matcher iterates the candidates'
// hashes in a single hot loop. That's why this lib is exported
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

// PINSCOPE.1 — who may sign in with a PIN, and against whom a PIN must be
// unique. A PIN used to identify a staffer across the WHOLE estate: the
// matcher scanned every active profile with a PIN and never asked whether
// the person belonged to the device's studio, so staff at one organisation,
// on their own paired device, could sign in as someone at another. The
// candidate set is now the people who can work at the device's studio,
// mirroring getCurrentUser's reach: a membership there (profile_locations),
// an org_admin grant on its organisation (SAAS-4), or the platform master.
// Uniqueness is per organisation (every org the caller can reach), so a PIN
// can repeat between tenants but never inside one.

const PIN_HOLDER_COLUMNS = 'id, full_name, pin_hash, active'

export class PinAmbiguousError extends Error {
  constructor() {
    super('findProfileByPin: more than one candidate holds this PIN')
    this.name = 'PinAmbiguousError'
  }
}

function tooMany(safetyCap) {
  return new Error(
    `more than ${safetyCap} profiles at this studio have a PIN set — refusing to scan. Check for stale PINs on deactivated profiles.`,
  )
}

// Collect PIN-holding profiles from the embed rows of a membership or
// grant table, plus the platform masters, deduped by id.
function collectHolders(groups) {
  const byId = new Map()
  for (const rows of groups) {
    for (const r of rows || []) {
      const p = r?.profiles ?? r
      if (!p?.id || !p.pin_hash || p.active !== true) continue
      byId.set(p.id, { id: p.id, full_name: p.full_name, pin_hash: p.pin_hash })
    }
  }
  return [...byId.values()]
}

async function masterPinHolders(db, cap) {
  const { data, error } = await db
    .from('profiles')
    .select(PIN_HOLDER_COLUMNS)
    .eq('role', 'master')
    .eq('active', true)
    .not('pin_hash', 'is', null)
    .limit(cap + 1)
  if (error) throw new Error(error.message)
  return data || []
}

/**
 * Active PIN holders who can work at `locationId`: members there, org
 * admins of its organisation, and masters.
 *
 * @returns {Promise<Array<{id: string, full_name: string, pin_hash: string}>>}
 */
export async function pinHoldersAtLocation({ db, locationId, safetyCap = 200 }) {
  if (!locationId) throw new Error('pinHoldersAtLocation: locationId is required')

  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (locErr) throw new Error(locErr.message)

  const membersQuery = db
    .from('profile_locations')
    .select(`profiles!inner(${PIN_HOLDER_COLUMNS})`)
    .eq('location_id', locationId)
    .not('profiles.pin_hash', 'is', null)
    .eq('profiles.active', true)
    .limit(safetyCap + 1)
  const adminsQuery = loc?.organization_id
    ? db
        .from('profile_organizations')
        .select(`profiles!inner(${PIN_HOLDER_COLUMNS})`)
        .eq('organization_id', loc.organization_id)
        .eq('role', 'org_admin')
        .not('profiles.pin_hash', 'is', null)
        .eq('profiles.active', true)
        .limit(safetyCap + 1)
    : Promise.resolve({ data: [], error: null })

  const [members, admins, masters] = await Promise.all([
    membersQuery, adminsQuery, masterPinHolders(db, safetyCap),
  ])
  if (members.error) throw new Error(members.error.message)
  if (admins.error) throw new Error(admins.error.message)

  const holders = collectHolders([members.data, admins.data, masters])
  if (holders.length > safetyCap) throw tooMany(safetyCap)
  return holders
}

/**
 * Active PIN holders who can work anywhere in `orgIds`: members at any of
 * their locations, their org admins, and masters. The uniqueness pool for a
 * PIN set by someone who reaches those organisations.
 */
export async function pinHoldersInOrgs({ db, orgIds, safetyCap = 200 }) {
  const ids = [...new Set((orgIds || []).filter(Boolean))]
  if (ids.length === 0) return collectHolders([await masterPinHolders(db, safetyCap)])

  const [members, admins, masters] = await Promise.all([
    db
      .from('profile_locations')
      .select(`profiles!inner(${PIN_HOLDER_COLUMNS}), locations!inner(organization_id)`)
      .in('locations.organization_id', ids)
      .not('profiles.pin_hash', 'is', null)
      .eq('profiles.active', true)
      .limit(safetyCap * 4),
    db
      .from('profile_organizations')
      .select(`profiles!inner(${PIN_HOLDER_COLUMNS})`)
      .in('organization_id', ids)
      .eq('role', 'org_admin')
      .not('profiles.pin_hash', 'is', null)
      .eq('profiles.active', true)
      .limit(safetyCap + 1),
    masterPinHolders(db, safetyCap),
  ])
  if (members.error) throw new Error(members.error.message)
  if (admins.error) throw new Error(admins.error.message)

  const holders = collectHolders([members.data, admins.data, masters])
  if (holders.length > safetyCap) throw tooMany(safetyCap)
  return holders
}

/**
 * Find the profile whose PIN matches, among the people who can work at the
 * device's studio (see pinHoldersAtLocation). Runs verifyPin against each
 * candidate; every candidate is checked so a clash is caught rather than
 * resolved by row order.
 *
 * The iteration is the price we pay for hashing PINs at all — each hash
 * uses a fresh salt, so there is no indexed lookup. ~50ms per verify; the
 * per-device rate-limit means a brute-forcer doesn't get the benefit.
 *
 * @param {object} args
 * @param {object} args.db           — service-role Supabase client
 * @param {string} args.pin          — 4 digits
 * @param {string} args.locationId   — the paired device's location
 * @param {number} [args.safetyCap]  — max candidates; default 200
 * @returns {Promise<{id: string, full_name: string} | null>}
 * @throws {PinAmbiguousError} when two candidates hold the same PIN
 */
export async function findProfileByPin({ db, pin, locationId, safetyCap = 200 }) {
  if (!isValidPinFormat(pin)) return null
  if (!locationId) throw new Error('findProfileByPin: locationId is required')

  const candidates = await pinHoldersAtLocation({ db, locationId, safetyCap })
  let match = null
  for (const p of candidates) {
    if (await verifyPin(pin, p.pin_hash)) {
      if (match) throw new PinAmbiguousError()
      match = { id: p.id, full_name: p.full_name }
    }
  }
  return match
}
