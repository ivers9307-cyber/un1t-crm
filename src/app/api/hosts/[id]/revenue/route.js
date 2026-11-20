// GET /api/hosts/[id]/revenue
//
// Per-host ticket revenue rollup: gross collected, UN1T's booking-fee take,
// net settling to the host, refunds, and a per-event breakdown. Read-only.
// Manager+ (ADMIN_ROLES), org-scoped — 404 on a cross-org id (no IDOR
// enumeration), matching the rest of the /api/hosts surface. (EVENTS-HOST.8)

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { ADMIN_ROLES } from '@/lib/schemas'
import { loadHostForOrg } from '@/lib/hosts'
import { getHostRevenue } from '@/lib/host-revenue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ADMIN_ROLES on user.role (the active studio's role), as before.
export const GET = withAuth(
  { permission: null, location: false, roles: ADMIN_ROLES, forbiddenMessage: 'Manager+ required' },
  async ({ user, db, params }) => {
    const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
    if (!orgId) return NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 })

    const host = await loadHostForOrg(db, params?.id, orgId)
    if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })

    const revenue = await getHostRevenue(db, host.id)
    return NextResponse.json({ success: true, data: revenue })
  },
)
