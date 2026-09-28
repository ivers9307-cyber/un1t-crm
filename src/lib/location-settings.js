// SETTINGSWIPE.1 — the one way a server route changes locations.settings.
//
// locations.settings is ONE jsonb column holding every per-location config
// slice: the Glofox credentials, UniFi, the Meta CAPI token, the WhatsApp
// booking Flow, InBody, Mia's settings, scoring, card sets… Some of those have
// no editor at all (seeded by SQL), so losing them means rebuilding by hand.
//
// Seven routes used to do `const { data: loc } = await …single()` (error
// discarded) and then write `{ ...(loc?.settings || {}), key }` back. A failed
// read made `loc` null, and the write replaced EVERY key with the one slice
// being saved. This helper is the replacement:
//   - the read's error is judged: a failed read writes NOTHING (read_failed);
//     PGRST116 (no row) is not_found;
//   - a stored value that is not an object is refused, never replaced;
//   - `mutate` gets a shallow copy of the stored object and returns the next
//     one (or null = no change, nothing written);
//   - the write is judged, and `.select('id').single()` turns a zero-row
//     UPDATE into not_found instead of a silent success.
// It never throws on a DB error; it returns { ok, reason?, settings?, unchanged? }.
//
// Still read-modify-write, so two writers racing on the same location could
// lose one key. Measured on prod (28 Sep 2026): 38 settings writes in 108
// days, the closest two 4.7 s apart, 0 lost keys. If a high-rate writer ever
// appears, swap the body for the RPC in the C23 plan's Appendix A; callers
// do not change.
//
// Every server writer goes through here or sits on the reviewed allowlist in
// tests/location-settings-writers.test.js.

import { NextResponse } from 'next/server'
import { logError } from '@/lib/log'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const NO_ROW = 'PGRST116'

/**
 * @param {object} db            service-role supabase client
 * @param {string} locationId
 * @param {(current: object) => object|null} mutate  returns the NEXT settings
 *        object (it may modify and return `current`), or null for "no change"
 * @param {{ alsoSet?: object, scope?: string }} [opts]  alsoSet: other
 *        `locations` columns written in the same UPDATE (can never override
 *        `settings`/`updated_at`); scope: the logError module name
 * @returns {Promise<{ ok: true, unchanged: boolean, settings: object } |
 *                   { ok: false, reason: 'read_failed'|'not_found'|'write_failed' }>}
 */
export async function mergeLocationSettings(db, locationId, mutate, { alsoSet = null, scope = 'location-settings' } = {}) {
  const { data: row, error: readErr } = await db
    .from('locations')
    .select('settings')
    .eq('id', locationId)
    .single()
  if (readErr) {
    if (readErr.code === NO_ROW) return { ok: false, reason: 'not_found' }
    logError(scope, 'locations.settings read failed; nothing written', { locationId, err: readErr.message })
    return { ok: false, reason: 'read_failed' }
  }
  if (!row) return { ok: false, reason: 'not_found' }

  const stored = row.settings
  if (stored != null && !isPlainObject(stored)) {
    // Never log the value: settings hold credentials.
    logError(scope, 'locations.settings is not an object; nothing written', {
      locationId, type: Array.isArray(stored) ? 'array' : typeof stored,
    })
    return { ok: false, reason: 'read_failed' }
  }

  const current = { ...(stored || {}) }
  const next = mutate(current)
  if (next === null) return { ok: true, unchanged: true, settings: current }
  if (!isPlainObject(next)) {
    throw new TypeError('mergeLocationSettings: mutate must return the next settings object, or null for "no change"')
  }

  const { data: written, error: writeErr } = await db
    .from('locations')
    .update({ ...(alsoSet || {}), settings: next, updated_at: new Date().toISOString() })
    .eq('id', locationId)
    .select('id')
    .single()
  if (writeErr) {
    if (writeErr.code === NO_ROW) return { ok: false, reason: 'not_found' }
    logError(scope, 'locations.settings write failed', { locationId, err: writeErr.message })
    return { ok: false, reason: 'write_failed' }
  }
  if (!written) return { ok: false, reason: 'not_found' }
  return { ok: true, unchanged: false, settings: next }
}

/** The route response for a failed mergeLocationSettings result. */
export function settingsSaveFailure(result) {
  if (result.reason === 'not_found') {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }
  if (result.reason === 'read_failed') {
    return NextResponse.json({
      success: false,
      code: 'settings_unreadable',
      error: "Could not read this location's settings just now, so nothing was saved. Try again.",
    }, { status: 500 })
  }
  return NextResponse.json({
    success: false,
    code: 'settings_write_failed',
    error: 'Could not save just now. Try again.',
  }, { status: 500 })
}
