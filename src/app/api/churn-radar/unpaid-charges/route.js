// GET /api/churn-radar/unpaid-charges
//
// RADAR-OVERDUE.1 — the small-charges tab: contacts with an open PAST_DUE
// invoice whose total owed is below OVERDUE_MIN_CENTS (€50). These are the
// little custom charges (a €5–€10 fee) that would otherwise clutter the
// main Overdue chase-list. Same row shape as Overdue.
//
// Access: churn_radar permission (owner + head_coach by default).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadUnpaidCharges } from '@/lib/churn-radar-data'
import { radarCache } from '@/lib/radar-cache'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'churn_radar')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const db = createServerClient()
  try {
    const data = await radarCache('churn', locationId, 'unpaid-charges', () => loadUnpaidCharges(db, locationId))
    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'fetch_failed' }, { status: 500 })
  }
}
