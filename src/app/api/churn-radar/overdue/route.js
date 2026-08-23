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
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadOverdue } from '@/lib/churn-radar-data'
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
    const data = await radarCache('churn', locationId, 'overdue', () => loadOverdue(db, locationId))
    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'fetch_failed' }, { status: 500 })
  }
}
