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
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadAwaitingAuth } from '@/lib/churn-radar-data'
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
    const data = await radarCache('churn', locationId, 'awaiting-authorization', () => loadAwaitingAuth(db, locationId))
    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'fetch_failed' }, { status: 500 })
  }
}
