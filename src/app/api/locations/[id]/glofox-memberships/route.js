// GET /api/locations/[id]/glofox-memberships
//
// Returns the membership catalog (Membership + plans[]) at this
// location's Glofox studio. Powers the LocationForm trial-
// membership picker (GLOFOX3.1) so the operator can choose which
// membership + plan to attach to freshly-created Glofox accounts.
//
// Auth (TRAINERSROLE.1): master, or owner/manager AT THIS LOCATION
// (ADMIN_ROLES). Membership first (404), then the role judged at the PATH id
// with hasRoleAtLocation, never `user.role` (the ACTIVE studio's role). Same
// gate as /glofox-trainers and /unifi-users.

import { NextResponse } from 'next/server'
import { GLOFOX_SETTINGS_UNREADABLE, GLOFOX_SETTINGS_UNREADABLE_MESSAGE } from '@/lib/glofox-settings-read'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
import { glofoxCredentialsForLocation, listGlofoxMemberships } from '@/lib/glofox'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
  const creds = await glofoxCredentialsForLocation(db, locationId)
  // REGISTRYREAD.1b: a failed settings read is not "not configured".
  if (creds.readError) {
    return NextResponse.json({ success: false, error: GLOFOX_SETTINGS_UNREADABLE, message: GLOFOX_SETTINGS_UNREADABLE_MESSAGE }, { status: 503 })
  }
  if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
    return NextResponse.json({
      success: false, error: 'glofox_not_configured',
      message: 'Set Glofox host + api_key + api_token on this location first.',
    }, { status: 400 })
  }

  const result = await listGlofoxMemberships(creds)
  if (!result.ok) {
    return NextResponse.json({
      success: false, error: 'glofox_request_failed',
      message: result.error,
    }, { status: 502 })
  }
  return NextResponse.json({
    success: true,
    memberships: result.memberships,
    count: result.memberships.length,
  })
}
