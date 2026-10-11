// src/lib/display-zone.js — TZ.11a. The zone a DISPLAY read (a dashboard
// number, a label) uses for one location.
//
//   • The signed-in user's active location already carries `timezone`
//     (CLIENT_LOCATION_COLUMNS), so that one costs no query.
//   • Any other location is read with getLocationZone (cached 60 s).
//   • A failed read falls back EXPLICITLY to DEFAULT_TZ with a logged warning:
//     a dashboard tile on the platform calendar beats a blank page. Never use
//     this for a decision or a send (scheduled reports, briefings, digests):
//     those let LocationZoneReadError skip the location instead.
import { getLocationZone, getLocationZones, zoneOfLocation, DEFAULT_TZ } from '@/lib/location-time'
import { logWarn } from '@/lib/log'

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {{ activeLocation?: { id?: string, timezone?: string|null } }|null} user
 * @param {string|null|undefined} locationId
 * @param {string} module log module name
 * @returns {Promise<string>} canonical IANA zone
 */
export async function displayZoneFor(db, user, locationId, module) {
  const active = user?.activeLocation
  if (active?.id && active.id === locationId && active.timezone !== undefined) return zoneOfLocation(active)
  try {
    return await getLocationZone(db, locationId)
  } catch (err) {
    logWarn(module, 'locations.timezone unreadable; display falls back to DEFAULT_TZ', { locationId, err: err?.message || String(err) })
    return DEFAULT_TZ
  }
}

/**
 * TZ.8b — the display zones of several locations: the session's own copies
 * first (the active studio and user.locations, no query), then ONE cached
 * batch read for the rest. A failed read falls back to DEFAULT_TZ for the
 * ones it could not read, with one warning: display only, never a decision.
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {object|null} user getCurrentUser()'s user
 * @param {Array<string|null|undefined>} locationIds
 * @param {string} module log module name
 * @returns {Promise<Map<string, string>>} id → canonical IANA zone
 */
export async function displayZonesFor(db, user, locationIds, module) {
  const out = new Map()
  const held = new Map()
  for (const loc of [user?.activeLocation, ...(user?.locations || [])]) {
    if (loc?.id && loc.timezone !== undefined && !held.has(loc.id)) held.set(loc.id, loc)
  }
  const missing = []
  for (const id of new Set((locationIds || []).filter(Boolean))) {
    if (held.has(id)) out.set(id, zoneOfLocation(held.get(id)))
    else missing.push(id)
  }
  if (missing.length === 0) return out
  try {
    for (const [id, zone] of await getLocationZones(db, missing)) out.set(id, zone)
  } catch (err) {
    logWarn(module, 'locations.timezone unreadable; display falls back to DEFAULT_TZ', { locationIds: missing, err: err?.message || String(err) })
    for (const id of missing) out.set(id, DEFAULT_TZ)
  }
  return out
}
