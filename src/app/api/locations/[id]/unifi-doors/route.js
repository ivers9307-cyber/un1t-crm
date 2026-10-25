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
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
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

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'unauthenticated' }, { status: 401 })

  const { id: locationId } = await params
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'missing_location_id' }, { status: 400 })
  }

  const denied = assertLocationAccessOr404(user, locationId)
  if (denied) return denied
  if (!hasRoleAtLocation(user, locationId, ADMIN_ROLES)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  const db = createServerClient()
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
    return NextResponse.json({
      success: false,
      error: 'unifi_request_failed',
      message: e.message || String(e),
    }, { status })
  }
}
