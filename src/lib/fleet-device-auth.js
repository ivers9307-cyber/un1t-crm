// FLEET-CMD.1 — per-device credentials for the Pi agent.
//
// Mirrors src/lib/bridge-auth.js deliberately: a random opaque token, stored
// only as a sha256 hash, presented as a bearer. Not a JWT and not a Supabase
// auth user — see the note in fleet-doorbell.js for why creating auth users
// per Pi would have silently minted a staff account for every TV.
//
// What a stolen token buys an attacker: the ability to fetch and complete
// commands for ONE device. It cannot issue commands (that needs a staff
// session with the right permission), cannot read another device's queue, and
// cannot read anything else in the database. Revocation is a rotation plus a
// `pi deploy`.

import { randomBytes } from 'node:crypto'
import { sha256Hex } from '@/lib/bridge-auth'

const TOKEN_PREFIX = 'fdv_'

/**
 * Mint a token. The raw value is returned ONCE — only the hash is persisted,
 * so a lost token means a rotation, never a lookup.
 *
 * @returns {{ raw: string, hash: string }}
 */
export function issueDeviceToken() {
  const raw = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  return { raw, hash: sha256Hex(raw) }
}

/**
 * Resolve an incoming bearer token to the device it authenticates as.
 *
 * Returns null for a missing/malformed header, an unknown token, or a device
 * whose token has been rotated. Callers must treat null as 401 and must NOT
 * disclose which of those it was.
 *
 * @param {Request} request
 * @param {object} db  service-role Supabase client
 * @returns {Promise<{ device_name: string, role: string|null, location_id: string|null }|null>}
 */
export async function verifyFleetDeviceToken(request, db) {
  const header = request.headers.get('authorization') || ''
  if (!header.startsWith('Bearer ')) return null

  const raw = header.slice('Bearer '.length).trim()
  // Check the shape before hashing so a stray session JWT or an empty string
  // never becomes a database round-trip.
  if (!raw.startsWith(TOKEN_PREFIX) || raw.length < TOKEN_PREFIX.length + 20) return null

  const { data, error } = await db
    .from('fleet_devices')
    .select('device_name, role, location_id')
    .eq('api_token_hash', sha256Hex(raw))
    .maybeSingle()

  if (error || !data) return null
  return data
}
