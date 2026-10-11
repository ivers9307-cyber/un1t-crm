// src/lib/staff-zone.js
//
// TZ.8a — the clock a member of staff's OWN, cross-studio things are judged
// on: their availability ("my availability" today, which dated rules have
// started or ended) and their subscribed shift calendar's window. These are
// about the PERSON, not one studio, so they take the person's studio:
//
//   - with a session: the ACTIVE studio (user.activeLocation, the one the web
//     switcher or the phone's x-active-location header picked), so the editor
//     the page renders and the route that saves it read the same day;
//   - without one (the ICS feed, token-authenticated): the person's DEFAULT
//     studio link (profile_locations.is_default), else their first link by
//     location id, the same order getCurrentUser falls back through.
//
// No studio at all is DEFAULT_TZ. Staff-facing reads only: an unreadable link
// falls back to DEFAULT_TZ with a warning, never an error page. A shift's own
// decisions (past, started, reminders) use THAT shift's studio zone instead.

import { zoneOfLocation, getLocationZone, DEFAULT_TZ } from './location-time'
import { logWarn } from './log'

/** The signed-in person's studio clock: their active studio. Never throws. */
export function staffZoneOfUser(user) {
  return zoneOfLocation(user?.activeLocation)
}

/**
 * The zone of one studio as the session already holds it (getCurrentUser's
 * `locations` carry CLIENT_LOCATION_COLUMNS, timezone included), or null
 * when the session does not hold that studio (the caller then reads it).
 * No IO. Never throws.
 */
export function sessionStudioZone(user, locationId) {
  const row = locationId ? (user?.locations || []).find((l) => l?.id === locationId) : null
  return row ? zoneOfLocation(row) : null
}

/**
 * TZ.8b — the zone of ONE studio a decision is about (a leave request's
 * studio, the studio a list is filtered to): the session's copy when it holds
 * that studio (the active one first), else one cached read. No IO in the
 * common case.
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {object|null} user getCurrentUser()'s user
 * @param {string|null|undefined} locationId
 * @returns {Promise<string>} canonical IANA zone (DEFAULT_TZ for no id)
 * @throws {LocationZoneReadError} the read failed: a decision route answers 500
 */
export async function studioZoneFor(db, user, locationId) {
  if (!locationId) return DEFAULT_TZ
  const active = user?.activeLocation
  if (active?.id === locationId) return zoneOfLocation(active)
  return sessionStudioZone(user, locationId) ?? getLocationZone(db, locationId)
}

/**
 * A person's home-studio zone when there is no session. Never throws.
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {string} profileId
 * @returns {Promise<string>} canonical IANA zone
 */
export async function readStaffHomeZone(db, profileId) {
  if (!profileId) return DEFAULT_TZ
  try {
    const { data, error } = await db
      .from('profile_locations')
      .select('location_id, is_default, locations(id, timezone)')
      .eq('profile_id', profileId)
      .order('is_default', { ascending: false })
      .order('location_id', { ascending: true })
      .limit(1)
    if (error) throw new Error(error.message)
    const link = (data || [])[0]
    return link?.locations ? zoneOfLocation(link.locations) : DEFAULT_TZ
  } catch (e) {
    logWarn('staff-zone', `home studio unreadable; using ${DEFAULT_TZ} for this read`, { profileId, err: e?.message })
    return DEFAULT_TZ
  }
}
