// GET /api/locations/[id]/unifi-users
//
// Lists every UniFi Access user registered at the given location's
// controller. Powers the per-location UniFi user picker on the staff
// edit page (mig 120 attendance), so an owner / manager can manually
// link a CRM profile to an existing UniFi user.
//
// Auth (TRAINERSROLE.1): master, or owner/manager AT THIS LOCATION
// (ADMIN_ROLES), because reading the full user list at a controller is a
// sensitive operation (employee names, emails, employee numbers).
// Membership first (404), then the role judged at the PATH id with
// hasRoleAtLocation. Never `user.role`: StaffForm calls this once per studio
// the staff member is assigned to, whichever studio is active, and the
// active studio's role let a manager at one studio who is staff at another
// read the other's list.
//
// Returns:
//   { success: true, users: [{ id, full_name, user_email, employee_number,
//                              status, nfc_count }] }

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
import {
  getUnifiConfig,
  listUnifiUsers,
  UnifiError,
} from '@/lib/unifi-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'unauthenticated' }, { status: 401 })

  const { id: locationId } = await params
  if (!locationId) return NextResponse.json({ success: false, error: 'missing_location_id' }, { status: 400 })

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
  if (locErr || !location) {
    return NextResponse.json({ success: false, error: 'location_not_found' }, { status: 404 })
  }

  // INTEG-A2 dual-read: registry row first, legacy settings.unifi otherwise.
  const cfg = await getUnifiConfig(db, location)
  if (!cfg.configured) {
    // Distinct error so the picker UI can show a clear "configure
    // UniFi for this location first" message rather than a network
    // error.
    return NextResponse.json({
      success: false,
      error: 'unifi_not_configured',
      message: `UniFi Access is not configured for ${location.name}. Set host + token + policy IDs on the location first.`,
    }, { status: 400 })
  }

  try {
    const users = await listUnifiUsers(cfg)
    return NextResponse.json({ success: true, users, count: users.length })
  } catch (e) {
    const status = e instanceof UnifiError && e.status ? e.status : 502
    return NextResponse.json({
      success: false,
      error: 'unifi_request_failed',
      message: e.message || String(e),
    }, { status })
  }
}
