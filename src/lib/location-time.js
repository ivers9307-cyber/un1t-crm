// src/lib/location-time.js — TZ.1. The web/server import path for the zone
// maths (re-exported from @shared/zoned-time, so there is ONE implementation:
// tests/shared-pair-sync.test.js proves every binding by identity) plus the DB
// side: which zone a location runs in.
//
//   import { getLocationZone, todayStrIn, zonedWallClockToInstant } from '@/lib/location-time'
//   const zone = await getLocationZone(db, locationId)
//   const today = todayStrIn(zone)
//
// The zone is `locations.timezone`. Until mig 719 (TZ.2) hardens it the column
// is nullable free text, so a NULL is the Europe/Dublin floor (DEFAULT_TZ) and
// an invalid value is the same floor plus ONE warning per (instance, location):
// a cron must never throw on a bad row. A failed READ is the floor too, logged
// and NOT cached, so the next call asks again rather than pinning a studio to
// Dublin for a minute on one blip.
export * from '@shared/zoned-time'
import { resolveZoneWithFallback, DEFAULT_TZ } from '@shared/zoned-time'
import { logWarn } from '@/lib/log'

const TTL_MS = 60_000
const BATCH = 500 // ids per .in(): under the 1k row cap and the URL length limit
const _cache = new Map() // locationId → { zone, at }
const _warned = new Set()

function remember(id, raw, nowMs) {
  const { zone, fallback } = resolveZoneWithFallback(raw)
  if (fallback && !_warned.has(id)) {
    _warned.add(id)
    logWarn('location-time', 'invalid locations.timezone; using Europe/Dublin', { locationId: id, timezone: raw })
  }
  _cache.set(id, { zone, at: nowMs })
  return zone
}

/**
 * Zone of a location row already in hand ({ id?, timezone }). No IO. A row with
 * an id also refreshes this instance's cache entry for it.
 * @param {{ id?: string, timezone?: string|null }|null|undefined} loc
 * @returns {string} canonical IANA zone
 */
export function zoneOfLocation(loc) {
  if (!loc) return DEFAULT_TZ
  return loc.id ? remember(loc.id, loc.timezone, Date.now()) : resolveZoneWithFallback(loc.timezone).zone
}

/**
 * One location's zone; cached 60 s per instance. A read error is the Dublin
 * floor, logged, NOT cached.
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {string|null|undefined} locationId
 * @param {{ nowMs?: number }} [opts]
 * @returns {Promise<string>} canonical IANA zone
 */
export async function getLocationZone(db, locationId, { nowMs = Date.now() } = {}) {
  if (!locationId) return DEFAULT_TZ
  const hit = _cache.get(locationId)
  if (hit && nowMs - hit.at < TTL_MS) return hit.zone
  const { data, error } = await db.from('locations').select('id, timezone').eq('id', locationId).maybeSingle()
  if (error) {
    logWarn('location-time', 'locations.timezone unreadable; using Europe/Dublin', { locationId, err: error.message })
    return DEFAULT_TZ
  }
  return remember(locationId, data?.timezone ?? null, nowMs)
}

/**
 * Many zones in as few queries as possible (chunks of 500 ids, each ordered by
 * id), serving cached ids without IO. A failed chunk is the Dublin floor for
 * those ids, logged, NOT cached.
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {Array<string|null|undefined>} locationIds
 * @param {{ nowMs?: number }} [opts]
 * @returns {Promise<Map<string, string>>} id → canonical IANA zone
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
    if (error) {
      logWarn('location-time', 'locations.timezone batch unreadable; using Europe/Dublin', { count: ids.length, err: error.message })
      for (const id of ids) out.set(id, DEFAULT_TZ)
      continue
    }
    const rows = new Map((data || []).map((r) => [r.id, r.timezone]))
    for (const id of ids) out.set(id, remember(id, rows.get(id) ?? null, nowMs))
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
