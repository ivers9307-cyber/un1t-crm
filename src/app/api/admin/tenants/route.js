// GET /api/admin/tenants — master-only tenant roster (INTEG-D2).
//
// One row per organization: locations count, pinned-plan summary,
// combined wallet balance, MTD usage snapshot and health signals —
// plus the platform stat tiles (MRR / trials stub / past-due /
// top-ups MTD). Pure read; assembly lives in src/lib/admin-tenants.js.
//
// Platform-level surface (like /api/admin/plans): master role only,
// no per-location scoping — operating cross-tenant is its job.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getTenantsRoster } from '@/lib/admin-tenants'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const db = createServerClient()
  try {
    const data = await getTenantsRoster(db)
    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
