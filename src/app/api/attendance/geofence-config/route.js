// GET /api/attendance/geofence-config
//
// GEO-ATT.3 — the mobile app calls this after auth bootstrap (and on
// foreground) to learn which geofence regions to register and whether
// the background-location permission gate applies to this user.
// Scoped to the caller's own assignments — no params, no IDOR surface.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { geofenceFromLocationSettings, geofenceIsConfigured, DEFAULT_GATE_COPY } from '@/lib/geofence-attendance'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Signed in only: the caller's own assignments, any studio, no active-studio
// rule (as before). A failed read is logged and answered with a fixed 400 (it
// used to return the error text).
export const GET = withAuth({ permission: null, location: false }, async ({ user, db }) => {
  const { data: links, error: linkErr } = await db
    .from('profile_locations')
    .select('location_id, geofence_exempt')
    .eq('profile_id', user.id)
  if (linkErr) {
    logError('geofence-config', 'assignments unreadable', { err: linkErr })
    return NextResponse.json({ success: false, error: 'Could not read your studios.' }, { status: 400 })
  }

  const allIds = (links || []).map(l => l.location_id)
  const eligible = new Set((links || []).filter(l => !l.geofence_exempt).map(l => l.location_id))
  let regions = []
  const allRegions = []
  let gateCopy = null
  if (allIds.length > 0) {
    const { data: locs, error: locErr } = await db
      .from('locations')
      .select('id, settings')
      .in('id', allIds)
      .order('id')
    if (locErr) {
      logError('geofence-config', 'studio settings unreadable', { err: locErr })
      return NextResponse.json({ success: false, error: 'Could not read your studios.' }, { status: 400 })
    }
    for (const loc of locs || []) {
      const g = geofenceFromLocationSettings(loc.settings)
      if (!geofenceIsConfigured(g)) continue
      const region = { location_id: loc.id, latitude: g.latitude, longitude: g.longitude, radius_m: g.radiusM }
      allRegions.push(region)
      if (eligible.has(loc.id)) {
        regions.push(region)
        if (!gateCopy) gateCopy = g.gateCopy
      }
    }
  }
  // iOS caps region monitoring at 20 per app — keep headroom. Applies only
  // to `regions`, which mobile registers as OS-level geofences.
  regions = regions.slice(0, 15)
  // all_regions has no OS resource to protect (the Home/on-site resolver
  // just compares distances client-side) — left uncapped.

  return NextResponse.json({
    success: true,
    data: {
      required: regions.length > 0,
      gate_copy: gateCopy || DEFAULT_GATE_COPY,
      regions,
      // HOME-LOC.1 — exemption-blind copy for the Home/on-site resolver.
      // `regions` stays the attendance-registration list (exempt filtered).
      all_regions: allRegions,
    },
  })
})
