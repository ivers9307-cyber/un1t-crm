// GET /api/locations/[id]/unifi-doors
//
// Lists every door registered at the given location's UniFi Access
// controller. Powers the per-location door multi-select on the staff
// edit page — operators tick which doors a member is allowed to
// remote-unlock from the iOS Studio Management screen. The ticked
// set is persisted to profile_locations.unifi_door_ids (mig 182).
//
// Auth: master / owner / manager — same gates as /unifi-users at
// this location. Knowing which doors exist at a studio is sensitive
// enough that we don't expose it to staff.
//
// Returns:
//   { success: true, doors: [{ id, name }], count: <number> }

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import {
  getLocationUnifiConfig,
  listDoors,
  UnifiError,
} from '@/lib/unifi-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Mirrors the role gate on /unifi-users so the picker UX is symmetric
// — anyone who can see the user list can also see the door list.
const ALLOWED_ROLES = new Set(['master', 'owner', 'manager'])

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'unauthenticated' }, { status: 401 })
  if (!ALLOWED_ROLES.has(user.role)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  const { id: locationId } = await params
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'missing_location_id' }, { status: 400 })
  }

  // Master sees every location; owner/manager only their own.
  if (user.role !== 'master') {
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: location } = await db
    .from('locations')
    .select('id, name, settings')
    .eq('id', locationId)
    .maybeSingle()
  if (!location) {
    return NextResponse.json({ success: false, error: 'location_not_found' }, { status: 404 })
  }

  const cfg = getLocationUnifiConfig(location)
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
