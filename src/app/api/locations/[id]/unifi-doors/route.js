// GET /api/locations/[id]/unifi-doors
//
// Lists every door registered at the given location's UniFi Access
// controller. Powers the per-location door multi-select on the staff
// edit page — operators tick which doors a member is allowed to
// remote-unlock from the iOS Studio Management screen. The ticked
// set is persisted to profile_locations.unifi_door_ids (mig 182).
//
// Auth (TRAINERSROLE.1): master, or owner/manager AT THIS LOCATION
// (ADMIN_ROLES), the same gate as /unifi-users. Knowing which doors exist
// at a studio is sensitive enough that we don't expose it to staff.
// Membership first (404), then the role judged at the PATH id with
// hasRoleAtLocation, never `user.role` (the ACTIVE studio's role).
//
// Returns:
//   { success: true, doors: [{ id, name }], count: <number> }

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { ADMIN_ROLES } from '@/lib/schemas'
import { logError } from '@/lib/log'
import {
  getUnifiConfig,
  listDoors,
  UnifiError,
} from '@/lib/unifi-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'locations-unifi-doors'

// The URL's studio: not one of the caller's studios is a 404 (withAuth's
// 'param' mode), then ADMIN_ROLES AT that studio (masters pass), 403 'forbidden'.
export const GET = withAuth({ permission: null, location: 'param', roles: ADMIN_ROLES, forbiddenMessage: 'forbidden' }, async ({ db, locationId }) => {
  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, name, settings')
    .eq('id', locationId)
    .maybeSingle()
  // F3 (TRAINERSROLE.1): a failed read is a 500, logged. The error used to be
  // discarded, so a failed read fell into the 404 below and told the picker
  // "location not found" for a transient error.
  if (locErr) {
    logError(MODULE, 'could not read the location', { locationId, error: locErr.message })
    return NextResponse.json({ success: false, error: 'location_read_failed' }, { status: 500 })
  }
  if (!location) {
    return NextResponse.json({ success: false, error: 'location_not_found' }, { status: 404 })
  }

  // INTEG-A2 dual-read: registry row first, legacy settings.unifi otherwise.
  const cfg = await getUnifiConfig(db, location)
  if (!cfg.configured) {
    // Same shape as /unifi-users so the staff-form code can treat
    // both endpoints with one error-handling branch.
    return NextResponse.json({
      success: false,
      error: 'unifi_not_configured',
      message: `UniFi Access is not configured for ${location.name}.`,
    }, { status: 400 })
  }

  try {
    const raw = await listDoors(cfg)
    // Normalise camelCase / snake_case shape from different firmwares.
    const doors = raw
      .map((d) => ({
        id: d.id || d.unique_id || d.door_id,
        name: d.name || d.display_name || d.title || 'Unnamed door',
      }))
      .filter((d) => d.id)
      .sort((a, b) => a.name.localeCompare(b.name))
    return NextResponse.json({ success: true, doors, count: doors.length })
  } catch (e) {
    const status = e instanceof UnifiError && e.status ? e.status : 502
    // The controller's own text stays in the log, never the response.
    logError(MODULE, 'listing the doors failed', { locationId, status, err: e?.message || String(e) })
    return NextResponse.json({
      success: false,
      error: 'unifi_request_failed',
      message: 'The UniFi Access controller could not list the doors.',
    }, { status })
  }
})
