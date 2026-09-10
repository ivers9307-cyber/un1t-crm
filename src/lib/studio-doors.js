// src/lib/studio-doors.js
//
// UNIFI-DOORS-SCOPE (mig 182) — the door-allowlist intersection shared by
// every consumer of the UniFi door list.
//
// Background: GET /api/studio-management/doors previously returned every
// door from the UniFi controller unfiltered, which exposed the door
// inventory to any staff user with studio_management permission. Migration
// 182 added profile_locations.unifi_door_ids as a per-user per-location
// allowlist; the doors route was fixed to read it, fetch the controller's
// door list, and return the INTERSECTION.
//
// A second consumer (the Studio Controls home-screen widget's door picker)
// needs the exact same intersection. Extracted here — rather than
// re-derived in the new caller — so the allowlist logic cannot drift
// between the two call sites. This is a security barrier, not a
// convenience helper: any change here changes what doors a caller with
// a restricted allowlist can see.
//
// Returns a discriminated result instead of throwing so callers keep
// full control of their own HTTP status codes:
//   { ok: true, doors: [{id, name}], scope: 'unrestricted' | 'allowlist' }
//   { ok: false, reason: 'not_configured' }
//   { ok: false, reason: 'unifi_error', status, message }
//
// Location-row lookup (the 404 "location not found" case) stays with the
// caller — it's a route-level concern, not part of the door-scoping logic.

import { getUnifiConfig, listDoors, UnifiError } from '@/lib/unifi-access'

/**
 * @param {object} db - Supabase server client
 * @param {object} params
 * @param {object} params.user - the caller; only `user.id` is read
 * @param {object} params.location - the location row (id, name, settings)
 *   passed straight through to getUnifiConfig's dual-read
 * @param {string} params.locationId - the active location id
 */
export async function listAllowedDoors(db, { user, location, locationId }) {
  // INTEG-A2 dual-read: registry row first, legacy settings.unifi otherwise.
  const cfg = await getUnifiConfig(db, location)
  if (!cfg.configured) {
    return { ok: false, reason: 'not_configured' }
  }

  // Read the caller's door allowlist for THIS location. The
  // profile_locations row's unifi_door_ids is a text[] of door
  // identifiers from the UniFi controller, set via the staff edit UI.
  // NULL/undefined = legacy fallback (show all doors — applies to
  // manager+ roles after the mig 182 backfill).
  const { data: assignment } = await db
    .from('profile_locations')
    .select('unifi_door_ids')
    .eq('profile_id', user.id)
    .eq('location_id', locationId)
    .maybeSingle()
  const allowlist = assignment?.unifi_door_ids
  const isUnrestricted = allowlist === null || allowlist === undefined

  try {
    const doors = await listDoors(cfg)
    // Normalise UniFi's camelCase / snake_case door shape. Some
    // firmwares ship one, some the other; tolerate both.
    const normalised = doors.map((d) => ({
      id: d.id || d.unique_id || d.door_id,
      name: d.name || d.display_name || d.title || 'Unnamed door',
    })).filter(d => d.id)

    const filtered = isUnrestricted
      ? normalised
      : normalised.filter(d => allowlist.includes(d.id))

    return {
      ok: true,
      doors: filtered,
      // Surface the allowlist mode to the caller so a UI can render an
      // appropriate empty-state message ("ask an admin to enable doors
      // for you" vs "this location has no doors registered").
      scope: isUnrestricted ? 'unrestricted' : 'allowlist',
    }
  } catch (e) {
    const status = e instanceof UnifiError && e.status ? e.status : 502
    return {
      ok: false,
      reason: 'unifi_error',
      status,
      message: e instanceof UnifiError ? e.message : `UniFi request failed: ${e.message || e}`,
    }
  }
}
