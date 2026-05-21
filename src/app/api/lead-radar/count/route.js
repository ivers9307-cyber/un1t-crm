// GET /api/lead-radar/count
//
// LEAD-RADAR.1 — sidebar badge count: high-tier funnel contacts at
// the active location (non-snoozed) — the ClassPass drop-ins worth
// converting now. Follows the { success, data: { count } } envelope
// the Sidebar's usePolledCount expects. Returns 0 for users without
// the permission rather than erroring.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadFunnel } from '@/lib/lead-radar-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'lead_radar')) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }

  const db = createServerClient()
  try {
    const { funnel } = await loadFunnel(db, locationId)
    const count = funnel.filter((r) => r.tier === 'high').length
    return NextResponse.json({ success: true, data: { count } })
  } catch {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }
}
