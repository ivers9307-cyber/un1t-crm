// GET /api/churn-radar
//
// CHURN-RADAR.1 — the scored at-risk member list + summary counts
// for the caller's active location. Snoozed members are excluded
// from the list but counted in the summary.
//
// Access: churn_radar permission (owner + head_coach by default).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { hasPermission } from '@/lib/permissions'
import { loadRadar } from '@/lib/churn-radar-data'
import { radarCache } from '@/lib/radar-cache'
import { radarAvailability, RADAR_UNAVAILABLE } from '@/lib/radar-availability'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// churn_radar at the active studio ('Forbidden' 403), then the active studio
// (400), in that order and with these texts, as before.
export const GET = withAuth(
  { permission: null, location: false, allow: (user) => hasPermission(user, 'churn_radar'), forbiddenMessage: 'Forbidden' },
  async ({ user, db }) => {
    const locationId = user.activeLocation?.id
    if (!locationId) {
      return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
    }

    try {
      // UN1TRADAR.1 — before the cache: a source without membership data answers data:null
      const avail = await radarAvailability(db, locationId, { module: 'churn-radar', withZone: true, withOutreach: true })
      if (!avail.available) return NextResponse.json(RADAR_UNAVAILABLE)
      const data = await radarCache('churn', locationId, 'radar', () => loadRadar(db, locationId))
      return NextResponse.json({ success: true, data, source: avail.source, dataAsOf: avail.dataAsOf, dataAsOfZone: avail.dataAsOfZone ?? null, outreachAvailable: avail.outreachAvailable ?? null })
    } catch (err) {
      logError('churn-radar', 'radar read failed', { err, locationId })
      return NextResponse.json({ success: false, error: 'fetch_failed' }, { status: 500 })
    }
  },
)
