// INTEG-D1 — GET /api/settings/billing: the tenant Billing & usage
// assembler for /settings/billing.
//
// Access (mirrors the SAAS4-M3 /api/settings/org-usage WRITE tier —
// billing is an ownership surface, not an operations number):
//   - master: any org (?organization_id, defaults to active)
//   - owner: orgs they own ONLY (getOwnerOrganizationIds — includes
//     SAAS-4 org admins); a foreign organization_id returns 404, not
//     403, so org ids can't be existence-probed cross-tenant.
//   - everyone else: 403.
//
// READ-ONLY: aggregation lives in src/lib/billing-page.js. Location
// scoping: every tenant-table query in the lib filters by the org's
// own location ids (locations.eq(organization_id) → .eq/.in
// location_id).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getOwnerOrganizationIds } from '@/lib/auth'
import { getBillingPageData } from '@/lib/billing-page'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Resolve the target org for a caller. Cross-org probes by non-masters
// resolve to { notFound: true } — the route answers 404 (identical to
// a nonexistent org), never 403.
export function resolveBillingOrgId(user, requested) {
  if (user.role === 'master') {
    return { orgId: requested || user.activeOrganization?.id || null }
  }
  const owned = getOwnerOrganizationIds(user)
  const target = requested || user.activeOrganization?.id || owned[0] || null
  if (!target) return { orgId: null }
  if (!owned.includes(target)) return { notFound: true }
  return { orgId: target }
}

// GET /api/settings/billing?organization_id=xxx
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (user.role !== 'owner' && user.role !== 'master') {
    return NextResponse.json(
      { success: false, error: 'Billing is visible to owners only' },
      { status: 403 }
    )
  }

  const { searchParams } = new URL(request.url)
  const resolved = resolveBillingOrgId(user, searchParams.get('organization_id'))
  if (resolved.notFound) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (!resolved.orgId) {
    return NextResponse.json({ success: false, error: 'No organisation access' }, { status: 403 })
  }

  const db = createServerClient()
  const data = await getBillingPageData(db, resolved.orgId)
  return NextResponse.json({ success: true, data })
}
