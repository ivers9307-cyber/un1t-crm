// GET /api/locations/[id]/protect-faces
//
// Lists every known face enrolled in UniFi Protect's face library
// at the given location's controller. Powers the per-location
// ProtectFacePicker on the staff edit page (P2.4) so an owner /
// manager can manually link a CRM profile to an existing Protect
// face.
//
// Auth: master / owner / manager only — same gate as the staff
// edit page itself. Reading the full face library is a sensitive
// operation (face metadata + enrolment timestamps).
//
// Returns:
//   { success: true, faces: [{ id, name, enrolledAt }] }
// OR
//   { success: false, error, message? }
//
// The picker UI degrades gracefully when this returns
// 'unifi_protect_not_configured' or 'unifi_request_failed' —
// the operator can always paste a face id manually as the
// canonical fallback.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { getLocationProtectConfig, listKnownFaces } from '@/lib/unifi-protect'

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
  if (!locationId) return NextResponse.json({ success: false, error: 'missing_location_id' }, { status: 400 })

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

  const cfg = getLocationProtectConfig(location)
  if (!cfg.configured) {
    return NextResponse.json({
      success: false,
      error: 'unifi_protect_not_configured',
      message: `UniFi Protect is not configured for ${location.name}. Set host + api_key on the location first, or paste the face id manually below.`,
    }, { status: 400 })
  }

  const result = await listKnownFaces(cfg)
  if (!result.ok) {
    return NextResponse.json({
      success: false,
      error: 'unifi_request_failed',
      message: result.error || 'Could not reach Protect controller',
    }, { status: result.status || 502 })
  }
  return NextResponse.json({ success: true, faces: result.faces, count: result.faces.length })
}
