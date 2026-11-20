// GET /api/churn-radar/awaiting-authorization
//
// AWAITING-AUTH.1 — the "Awaiting authorization" tab: contacts with a PENDING
// custom-charge fee Glofox has applied but not yet collected (a no-show /
// late-cancel fee shown as "Awaiting authorization" in Glofox). These are not
// confirmed debts, so they're kept off the Overdue chase-list AND out of the
// Unpaid-charges tab. Same row shape as Overdue.
//
// Access: churn_radar permission (owner + head_coach by default).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadAwaitingAuth } from '@/lib/churn-radar-data'
import { radarCache } from '@/lib/radar-cache'
import { radarAvailability, RADAR_UNAVAILABLE } from '@/lib/radar-availability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// churn_radar at the active studio, which must be set (as before).
export const GET = withAuth({ permission: 'churn_radar', location: true }, async ({ db, locationId }) => {
  try {
    // UN1TRADAR.1 — before the cache: a source without membership data answers data:null
    const avail = await radarAvailability(db, locationId, { module: 'churn-radar' })
    if (!avail.available) return NextResponse.json(RADAR_UNAVAILABLE)
    const data = await radarCache('churn', locationId, 'awaiting-authorization', () => loadAwaitingAuth(db, locationId))
    return NextResponse.json({ success: true, data, source: avail.source, dataAsOf: avail.dataAsOf })
  } catch (err) {
    logError('churn-radar', 'awaiting-authorization read failed', { locationId, err })
    return NextResponse.json({ success: false, error: 'fetch_failed' }, { status: 500 })
  }
})
