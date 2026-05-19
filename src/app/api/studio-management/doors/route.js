// GET /api/studio-management/doors
//
// Returns the list of doors the CURRENT USER is allowed to remote-
// unlock at the active location. Powers the unlock-button list on
// /studio-management. Caller must have the studio_management
// permission AT their active location.
//
// UNIFI-DOORS-SCOPE — this endpoint previously returned every door
// from the UniFi controller unfiltered, which exposed the door
// inventory to any staff user with studio_management permission.
// Migration 182 added profile_locations.unifi_door_ids as a per-user
// per-location allowlist. The route now:
//   • Reads the user's allowlist for the active location
//   • Fetches the controller's door list
//   • Returns the INTERSECTION
// NULL allowlist (legacy fallback for manager+ roles) keeps the
// previous "show everything" behaviour. Empty array → no doors.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getLocationUnifiConfig, listDoors, UnifiError } from '@/lib/unifi-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, locationId }) => {
    const { data: location } = await db
      .from('locations')
      .select('id, name, settings')
      .eq('id', locationId)
      .single()
    if (!location) {
      return NextResponse.json({ success: false, error: 'Location not found.' }, { status: 404 })
    }

    const cfg = getLocationUnifiConfig(location)
    if (!cfg.configured) {
      return NextResponse.json({
        success: false,
        error: 'UniFi Access is not fully configured for this location. Ask a master to fill in the controller settings under Settings → Locations.',
        code: 'unifi_not_configured',
      }, { status: 412 })
    }

    // Read the caller's door allowlist for THIS location. The
    // profile_locations row's unifi_door_ids is a text[] of door
    // identifiers from the UniFi controller, set via the staff edit
    // UI. NULL = legacy fallback (show all doors — applies to
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

      return NextResponse.json({
        success: true,
        data: filtered,
        // Surface the allowlist mode to the UI so it can render an
        // appropriate empty-state message ("ask an admin to enable
        // doors for you" vs "this location has no doors registered").
        scope: isUnrestricted ? 'unrestricted' : 'allowlist',
      })
    } catch (e) {
      const status = e instanceof UnifiError && e.status ? e.status : 502
      return NextResponse.json({
        success: false,
        error: e instanceof UnifiError ? e.message : `UniFi request failed: ${e.message || e}`,
      }, { status })
    }
  }
)
