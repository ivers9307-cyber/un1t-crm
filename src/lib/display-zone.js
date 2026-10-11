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
import { getLocationZone, zoneOfLocation, DEFAULT_TZ } from '@/lib/location-time'
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
 * TZ.16 (D3 = A) — the viewer's zone on a SERVER render, for formatRecordTime's
 * suffix rule (src/lib/record-time.js). The server cannot see the browser's
 * zone, so it uses the viewer's active studio, which is where staff work: a
 * Dublin manager on a Dublin record sees no suffix, on a New York record "EST".
 * No active location → null (unknown viewer: no suffix, today's text).
 * @param {{ activeLocation?: { id?: string, timezone?: string|null } }|null|undefined} user
 * @returns {string|null}
 */
export function viewerZoneOf(user) {
  return user?.activeLocation ? zoneOfLocation(user.activeLocation) : null
}
