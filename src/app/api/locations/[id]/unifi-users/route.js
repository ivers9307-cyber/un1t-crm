// GET /api/locations/[id]/unifi-users
//
// Lists every UniFi Access user registered at the given location's
// controller. Powers the per-location UniFi user picker on the staff
// edit page (mig 120 attendance), so an owner / manager can manually
// link a CRM profile to an existing UniFi user.
//
// Auth: master / owner / manager only — these are the same gates that
// already protect /studio-management and /api/staff/[id], because
// reading the full user list at a controller is a sensitive operation
// (employee names, emails, employee numbers).
//
// Returns:
//   { success: true, users: [{ id, full_name, user_email, employee_number,
//                              status, nfc_count }] }

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import {
  getUnifiConfig,
  listUnifiUsers,
  UnifiError,
} from '@/lib/unifi-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Roles allowed to read the full UniFi user list. Mirrors the gate
// on the staff edit page so the picker is only available to people
// who can also see / edit the staff record itself.
const ALLOWED_ROLES = new Set(['master', 'owner', 'manager'])

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'unauthenticated' }, { status: 401 })
  if (!ALLOWED_ROLES.has(user.role)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  const { id: locationId } = await params
  if (!locationId) return NextResponse.json({ success: false, error: 'missing_location_id' }, { status: 400 })

  // Master sees every location; owner/manager only the locations they
  // belong to. Mirrors the per-location gate in /api/staff routes.
  if (user.role !== 'master') {
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
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
