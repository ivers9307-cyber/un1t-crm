// GET /api/attendance/geofence-config
//
// GEO-ATT.3 — the mobile app calls this after auth bootstrap (and on
// foreground) to learn which geofence regions to register and whether
// the background-location permission gate applies to this user.
// Scoped to the caller's own assignments — no params, no IDOR surface.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { geofenceFromLocationSettings, geofenceIsConfigured, DEFAULT_GATE_COPY } from '@/lib/geofence-attendance'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: links, error: linkErr } = await db
    .from('profile_locations')
    .select('location_id, geofence_exempt')
    .eq('profile_id', user.id)
  if (linkErr) return NextResponse.json({ success: false, error: linkErr.message }, { status: 400 })

  const eligibleIds = (links || []).filter(l => !l.geofence_exempt).map(l => l.location_id)
  let regions = []
  let gateCopy = null
  if (eligibleIds.length > 0) {
    const { data: locs, error: locErr } = await db
      .from('locations')
      .select('id, settings')
      .in('id', eligibleIds)
      .order('id')
    if (locErr) return NextResponse.json({ success: false, error: locErr.message }, { status: 400 })
    for (const loc of locs || []) {
      const g = geofenceFromLocationSettings(loc.settings)
      if (!geofenceIsConfigured(g)) continue
      regions.push({ location_id: loc.id, latitude: g.latitude, longitude: g.longitude, radius_m: g.radiusM })
      if (!gateCopy) gateCopy = g.gateCopy
    }
  }
  // iOS caps region monitoring at 20 per app — keep headroom.
  regions = regions.slice(0, 15)

  return NextResponse.json({
    success: true,
    data: { required: regions.length > 0, gate_copy: gateCopy || DEFAULT_GATE_COPY, regions },
  })
}
