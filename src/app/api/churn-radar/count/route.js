// GET /api/churn-radar/count
//
// CHURN-RADAR.1 — sidebar badge count: high-tier at-risk members at
// the active location (non-snoozed). Follows the { success, data:
// { count } } envelope the Sidebar's usePolledCount expects. Returns
// count 0 for users without the permission rather than erroring, so
// the poll is harmless if it somehow runs.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadRadar } from '@/lib/churn-radar-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'churn_radar')) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }

  const db = createServerClient()
  try {
    const { radar } = await loadRadar(db, locationId)
    const count = radar.filter((r) => r.tier === 'high').length
    return NextResponse.json({ success: true, data: { count } })
  } catch {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }
}
