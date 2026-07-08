// GET /api/hosts/[id]/revenue
//
// Per-host ticket revenue rollup: gross collected, UN1T's booking-fee take,
// net settling to the host, refunds, and a per-event breakdown. Read-only.
// Manager+ (ADMIN_ROLES), org-scoped — 404 on a cross-org id (no IDOR
// enumeration), matching the rest of the /api/hosts surface. (EVENTS-HOST.8)

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
import { loadHostForOrg } from '@/lib/hosts'
import { getHostRevenue } from '@/lib/host-revenue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 })

  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })

  const revenue = await getHostRevenue(db, host.id)
  return NextResponse.json({ success: true, data: revenue })
}
