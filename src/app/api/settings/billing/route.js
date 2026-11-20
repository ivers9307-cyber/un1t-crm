// INTEG-D1 — GET /api/settings/billing: the tenant Billing & usage
// assembler for /settings/billing.
//
// Access (C18 ORGROLE.1 — organisation admins only, Richard 1 Oct 2026):
//   - master: any org (?organization_id, defaults to active)
//   - an org admin (org_admin grant, mig 417): their admin orgs ONLY; a
//     foreign organization_id returns 404, not 403, so org ids can't be
//     existence-probed cross-tenant.
//   - everyone else, a studio owner included: 403. (It used to ask the
//     ACTIVE studio's role and getOwnerOrganizationIds.)
//
// READ-ONLY: aggregation lives in src/lib/billing-page.js. Location
// scoping: every tenant-table query in the lib filters by the org's
// own location ids (locations.eq(organization_id) → .eq/.in
// location_id).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { isOrgAdminSomewhere, resolveAdminOrgId } from '@/lib/org-admin'
import { getBillingPageData } from '@/lib/billing-page'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Resolve the target org for a caller. Cross-org probes by non-masters
// resolve to { notFound: true } — the route answers 404 (identical to
// a nonexistent org), never 403.
export function resolveBillingOrgId(user, requested) {
  return resolveAdminOrgId(user, requested)
}

// GET /api/settings/billing?organization_id=xxx
// withAuth only signs the caller in; the org-admin gate (403) and the
// organisation resolve (404 for a foreign one) stay below, as before.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  if (!isOrgAdminSomewhere(user)) {
    return NextResponse.json(
      { success: false, error: 'Billing is visible to organisation admins only' },
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

  const data = await getBillingPageData(db, resolved.orgId)
  return NextResponse.json({ success: true, data })
})
