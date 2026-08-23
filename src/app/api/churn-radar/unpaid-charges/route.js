// GET /api/churn-radar/unpaid-charges
//
// ARREARS-TYPE.1 — the "Unpaid charges" tab: contacts with an open CONFIRMED
// past-due charge that is NOT a membership payment — late-cancel / no-show
// fees, custom charges, class bookings, class packs, products — at any amount
// (the old <€50 rule is gone). Same row shape as Overdue.
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
