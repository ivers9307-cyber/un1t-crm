// GET /api/locations/[id]/glofox-memberships
//
// Returns the membership catalog (Membership + plans[]) at this
// location's Glofox studio. Powers the LocationForm trial-
// membership picker (GLOFOX3.1) so the operator can choose which
// membership + plan to attach to freshly-created Glofox accounts.
//
// Auth: master / owner / manager only (mirrors /unifi-users +
// /protect-faces — both touch sensitive integration data).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { glofoxCredentialsForLocation, listGlofoxMemberships } from '@/lib/glofox'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
  if (user.role !== 'master') {
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
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
