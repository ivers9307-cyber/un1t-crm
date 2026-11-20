// GET /api/churn-radar/overdue
//
// OVERDUE.1 / ARREARS-TYPE.1 — members whose MEMBERSHIP payment failed: an
// open PAST_DUE glofox_invoices row for a subscription renewal or first
// payment. A plain chase-list of customers who owe the business membership
// money, highest owed first. Other failed charges live under
// /api/churn-radar/unpaid-charges.
//
// Access: churn_radar permission (owner + head_coach by default).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadOverdue } from '@/lib/churn-radar-data'
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
    const data = await radarCache('churn', locationId, 'overdue', () => loadOverdue(db, locationId))
    return NextResponse.json({ success: true, data, source: avail.source, dataAsOf: avail.dataAsOf })
  } catch (err) {
    logError('churn-radar', 'overdue read failed', { locationId, err })
    return NextResponse.json({ success: false, error: 'fetch_failed' }, { status: 500 })
  }
})
