// GET /api/admin/tenants/[orgId] — master-only tenant drill-in
// (INTEG-D2): org header + per-location blocks (pinned plan, wallet +
// last-50 ledger, MTD meters vs allowance + exempt assistant line,
// integrations summary, stale heartbeats). Pure read; assembly lives
// in src/lib/admin-tenants.js.
//
// Detail route → 404 (not 403) for unknown/malformed ids so org ids
// can't be enumerated. Master role only.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { uuidLike } from '@/lib/validate'
import { getTenantDetail } from '@/lib/admin-tenants'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

// Master = profiles.role, as before (profileRole, not a studio role); no studio.
export const GET = withAuth(
  { permission: null, location: false, allow: (user) => user.profileRole === 'master', forbiddenMessage: 'Master only' },
  async ({ db, params }) => {
    // Malformed id = not found (never a Postgres cast error).
    if (!uuidLike.safeParse(params?.orgId).success) return notFound()
    try {
      const data = await getTenantDetail(db, params.orgId)
      if (!data) return notFound()
      return NextResponse.json({ success: true, data })
    } catch (err) {
      logError('admin-tenants', 'tenant detail failed', { orgId: params.orgId, err })
      return NextResponse.json({ success: false, error: 'Could not load the tenant.' }, { status: 500 })
    }
  },
)
