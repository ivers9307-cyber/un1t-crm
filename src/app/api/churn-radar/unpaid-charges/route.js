// GET /api/churn-radar/unpaid-charges
//
// ARREARS-TYPE.1 — the "Unpaid charges" tab: contacts with an open CONFIRMED
// past-due charge that is NOT a membership payment — late-cancel / no-show
// fees, custom charges, class bookings, class packs, products — at any amount
// (the old <€50 rule is gone). Same row shape as Overdue.
//
// Access: churn_radar permission (owner + head_coach by default).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadUnpaidCharges } from '@/lib/churn-radar-data'
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
    const data = await radarCache('churn', locationId, 'unpaid-charges', () => loadUnpaidCharges(db, locationId))
    return NextResponse.json({ success: true, data, source: avail.source, dataAsOf: avail.dataAsOf })
  } catch (err) {
    logError('churn-radar', 'unpaid-charges read failed', { locationId, err })
    return NextResponse.json({ success: false, error: 'fetch_failed' }, { status: 500 })
  }
})
