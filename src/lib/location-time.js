// src/lib/location-time.js — TZ.1. The web/server import path for the zone
// maths (re-exported from @shared/zoned-time, so there is ONE implementation:
// tests/shared-pair-sync.test.js proves every binding by identity) plus the DB
// side: which zone a location runs in.
//
//   import { getLocationZone, todayStrIn, zonedWallClockToInstant } from '@/lib/location-time'
//   const zone = await getLocationZone(db, locationId)   // throws LocationZoneReadError on a failed read
//   const today = todayStrIn(zone)
//
// The zone is `locations.timezone`. Until mig 719 (TZ.2) hardens it the column
// is nullable free text, so:
//   • NULL column, or no such row  → DEFAULT_TZ (Europe/Dublin), silently.
//   • invalid value                → DEFAULT_TZ + ONE warning per location.
//   • the READ FAILED              → LocationZoneReadError is THROWN, never a
//     silent Dublin: a scheduler acting for a non-Dublin studio in the wrong
//     zone sends at the wrong local time, so a decision/cron caller lets it
//     propagate and skips the cycle as it would on any DB outage. A
//     DISPLAY-ONLY caller may catch it and fall back explicitly:
//       const zone = await getLocationZone(db, id).catch(() => DEFAULT_TZ)
//
// Cache: 60 s per instance, holding only what the DATABASE said (a row's zone,
// NULL included). A failed read and a missing row are never cached, and
// nothing a caller hands in (zoneOfLocation) is ever written to it. Bounded at
// LOCATION_ZONE_CACHE_MAX entries, oldest evicted first; the once-per-location
// warning set is bounded the same way.
export * from '@shared/zoned-time'
import { resolveZoneWithFallback, DEFAULT_TZ } from '@shared/zoned-time'
import { logWarn } from '@/lib/log'

const TTL_MS = 60_000
const BATCH = 500 // ids per .in(): under the 1k row cap and the URL length limit
export const LOCATION_ZONE_CACHE_MAX = 5_000
const _cache = new Map() // locationId → { zone, at }; insertion order = age
const _warned = new Set() // insertion order = age

/** A `locations.timezone` read failed. Not cached; the next call reads again. */
export class LocationZoneReadError extends Error {
  constructor(locationIds, cause) {
    super(`locations.timezone unreadable: ${cause?.message || 'unknown error'}`)
    this.name = 'LocationZoneReadError'
    this.locationIds = locationIds
    this.cause = cause
  }
}

function boundedAdd(store, key, value) {
  // Re-inserting moves the key to the young end; then trim the old end.
  store.delete(key)
  if (store instanceof Map) store.set(key, value)
  else store.add(key)
  while (store.size > LOCATION_ZONE_CACHE_MAX) store.delete(store.keys().next().value)
}

// Resolve a raw column value, warning once per location for an invalid one.
function resolveFor(id, raw) {
  const { zone, fallback } = resolveZoneWithFallback(raw)
  if (fallback && id && !_warned.has(id)) {
    boundedAdd(_warned, id)
    logWarn('location-time', 'invalid locations.timezone; using Europe/Dublin', { locationId: id, timezone: raw })
  }
  return zone
}

// Only ever called with a row the database just returned.
function rememberDbRow(id, raw, nowMs) {
  const zone = resolveFor(id, raw)
  boundedAdd(_cache, id, { zone, at: nowMs })
  return zone
}

/**
 * Zone of a location row already in hand ({ id?, timezone }). No IO, and
 * read-only: it never writes the cache, so an object of any provenance is safe
 * to pass.
 * @param {{ id?: string, timezone?: string|null }|null|undefined} loc
 * @returns {string} canonical IANA zone
 */
export function zoneOfLocation(loc) {
  if (!loc) return DEFAULT_TZ
  return resolveFor(loc.id, loc.timezone)
}

/**
 * One location's zone; cached 60 s per instance.
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {string|null|undefined} locationId
 * @param {{ nowMs?: number }} [opts]
 * @returns {Promise<string>} canonical IANA zone (DEFAULT_TZ for no id, no row, or a NULL column)
 * @throws {LocationZoneReadError} the read failed (not cached)
 */
export async function getLocationZone(db, locationId, { nowMs = Date.now() } = {}) {
  if (!locationId) return DEFAULT_TZ
  const hit = _cache.get(locationId)
  if (hit && nowMs - hit.at < TTL_MS) return hit.zone
  const { data, error } = await db.from('locations').select('id, timezone').eq('id', locationId).maybeSingle()
  if (error) throw new LocationZoneReadError([locationId], error)
  if (!data) return DEFAULT_TZ // no such row: an answer, but not one to cache
  return rememberDbRow(locationId, data.timezone ?? null, nowMs)
}

/**
 * Many zones in as few queries as possible (chunks of 500 ids, each ordered by
 * id), serving cached ids without IO.
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {Array<string|null|undefined>} locationIds
 * @param {{ nowMs?: number }} [opts]
 * @returns {Promise<Map<string, string>>} id → canonical IANA zone (DEFAULT_TZ for no row / NULL)
 * @throws {LocationZoneReadError} any chunk's read failed (nothing from that chunk is cached)
 */
export async function getLocationZones(db, locationIds, { nowMs = Date.now() } = {}) {
  const out = new Map()
  const need = []
  for (const id of new Set((locationIds || []).filter(Boolean))) {
    const hit = _cache.get(id)
    if (hit && nowMs - hit.at < TTL_MS) out.set(id, hit.zone)
    else need.push(id)
  }
  for (let i = 0; i < need.length; i += BATCH) {
    const ids = need.slice(i, i + BATCH)
    const { data, error } = await db.from('locations').select('id, timezone').in('id', ids).order('id')
    if (error) throw new LocationZoneReadError(ids, error)
    const rows = new Map((data || []).map((r) => [r.id, r.timezone]))
    for (const id of ids) {
      out.set(id, rows.has(id) ? rememberDbRow(id, rows.get(id) ?? null, nowMs) : DEFAULT_TZ)
    }
  }
  return out
}

/** Drop this instance's cached zone for one location, or for all (TZ.3 calls it after a change). */
export function resetLocationZoneCache(locationId) {
  if (locationId) {
    _cache.delete(locationId)
    _warned.delete(locationId)
  } else {
    _cache.clear()
    _warned.clear()
  }
}
