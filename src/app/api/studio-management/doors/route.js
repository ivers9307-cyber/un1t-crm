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
// per-location allowlist. The allowlist-intersection logic (read the
// allowlist, fetch the controller's door list, return the
// INTERSECTION, normalise door shape) now lives in
// listAllowedDoors() (src/lib/studio-doors.js) — extracted so the
// Studio Controls widget's door picker (a second consumer of the
// door list) reuses the same barrier instead of re-deriving it.
// NULL allowlist (legacy fallback for manager+ roles) keeps the
// previous "show everything" behaviour. Empty array → no doors.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { listAllowedDoors } from '@/lib/studio-doors'

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

    const result = await listAllowedDoors(db, { user, location, locationId })

    if (!result.ok) {
      if (result.reason === 'not_configured') {
        return NextResponse.json({
          success: false,
          error: 'UniFi Access is not fully configured for this location. Ask a master to fill in the controller settings under Settings → Locations.',
          code: 'unifi_not_configured',
        }, { status: 412 })
      }
      return NextResponse.json({
        success: false,
        error: result.message,
      }, { status: result.status })
    }

    return NextResponse.json({
      success: true,
      data: result.doors,
      // Surface the allowlist mode to the UI so it can render an
      // appropriate empty-state message ("ask an admin to enable
      // doors for you" vs "this location has no doors registered").
      scope: result.scope,
    })
  }
)
