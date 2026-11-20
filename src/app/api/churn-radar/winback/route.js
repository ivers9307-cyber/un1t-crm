// GET /api/churn-radar/winback
//
// WINBACK.1 — former members worth re-winning: paying members (or
// ex_members) with a real attendance footprint who last trained
// 45–365 days ago. Past the at-risk window, not yet a lost cause.
// Snoozed contacts are excluded from the list but counted.
//
// Access: churn_radar permission (owner + head_coach by default).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadWinback } from '@/lib/churn-radar-data'
import { radarCache } from '@/lib/radar-cache'
import { radarAvailability, RADAR_UNAVAILABLE } from '@/lib/radar-availability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// churn_radar at the active studio, which must be set (as before).
export const GET = withAuth({ permission: 'churn_radar', location: true }, async ({ db, locationId }) => {
  try {
    // UN1TRADAR.1 — before the cache: a source without membership data answers data:null
    const avail = await radarAvailability(db, locationId, { module: 'churn-radar', withOutreach: true })
    if (!avail.available) return NextResponse.json(RADAR_UNAVAILABLE)
    const data = await radarCache('churn', locationId, 'winback', () => loadWinback(db, locationId))
    return NextResponse.json({ success: true, data, source: avail.source, dataAsOf: avail.dataAsOf, outreachAvailable: avail.outreachAvailable ?? null })
  } catch (err) {
    logError('churn-radar', 'winback read failed', { locationId, err })
    return NextResponse.json({ success: false, error: 'fetch_failed' }, { status: 500 })
  }
})
