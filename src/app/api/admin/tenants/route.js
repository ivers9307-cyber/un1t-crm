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
import { withAuth } from '@/lib/with-auth'
import { getTenantsRoster } from '@/lib/admin-tenants'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Masters only (profiles.role), as before; no studio.
export const GET = withAuth(
  { permission: null, location: false, allow: (user) => user.profileRole === 'master', forbiddenMessage: 'Master only' },
  async ({ db }) => {
    try {
      const data = await getTenantsRoster(db)
      return NextResponse.json({ success: true, data })
    } catch (err) {
      logError('admin-tenants', 'roster failed', { err })
      return NextResponse.json({ success: false, error: 'Could not load the tenants.' }, { status: 500 })
    }
  },
)
