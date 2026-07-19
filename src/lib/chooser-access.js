// Org resolution + access tiers for the front-page chooser surface
// (/api/chooser-settings + its tile-image upload). SAAS-6: the chooser
// is per-ORGANIZATION (mig 414) — each tenant brand gets its own front
// page — so both routes share one answer to "which org is the caller
// targeting, and may they touch it?".
//
// Two tiers, mirroring the SAAS-4 org guards in @/lib/auth:
//   • read  = org MEMBERSHIP (assertOrganizationAccess semantics)
//   • edit  = master, org_admin of the org, or an OWNER within the org
//     (getOwnerOrganizationIds — the same delegation tier that manages
//     org branding, mig 317). Pre-SAAS-6 the gate was master-or-ANY-
//     owner, which let one tenant's owner edit another tenant's front
//     page; the org bound closes that hole.
//
// A FOREIGN org answers 404 on both tiers — indistinguishable from an
// org that doesn't exist (assertOrganizationAccessOr404 rationale: the
// requested id must never confirm another tenant's existence). A
// member without edit rights on their OWN org gets an honest 403.

import { NextResponse } from 'next/server'
import { getOwnerOrganizationIds } from '@/lib/auth'
import { uuidLike } from '@/lib/schemas'

/**
 * Row id for a per-org chooser row. The legacy UN1T row keeps
 * id='default' (backfilled to the un1t-group org in mig 414); new orgs
 * get 'org:<uuid>'. One-row-per-org is enforced by the UNIQUE index on
 * organization_id, and mig 414's CHECK pins ids to exactly these two
 * shapes.
 *
 * @param {string} orgId
 * @returns {string}
 */
export function chooserRowId(orgId) {
  return `org:${orgId}`
}

/**
 * Resolve the org the caller is targeting: an explicit
 * ?organization_id wins, else their activeOrganization. Returns null
 * for a malformed explicit id (the guards then 404 rather than letting
 * junk reach a query).
 *
 * @param {{ activeOrganization?: { id?: string } } | null} user
 * @param {Request} request
 * @returns {string | null}
 */
export function resolveChooserOrgId(user, request) {
  const { searchParams } = new URL(request.url)
  const requested = searchParams.get('organization_id')
  if (requested) {
    return uuidLike.safeParse(requested).success ? requested : null
  }
  return user?.activeOrganization?.id || null
}

// Membership probe: is the org reachable by this caller at all?
// organizationsById is exactly the reachable set (getCurrentUser), with
// orgAdminOrgIds as the belt-and-braces union for a zero-location org.
function orgReachable(user, orgId) {
  return !!user.organizationsById?.[orgId]
    || (user.orgAdminOrgIds || []).includes(orgId)
}

/**
 * Read tier. null = proceed; otherwise the NextResponse to return.
 *
 * @param {object | null} user
 * @param {string | null} orgId
 * @returns {NextResponse | null}
 */
export function assertChooserRead(user, orgId) {
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!orgId) {
    return NextResponse.json({ success: false, error: 'organization_id is required' }, { status: 400 })
  }
  if (user.isMaster) return null
  if (orgReachable(user, orgId)) return null
  return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
}

/**
 * Edit tier. null = proceed; otherwise the NextResponse to return
 * (404 for a foreign org, 403 for a mere member of the org).
 *
 * @param {object | null} user
 * @param {string | null} orgId
 * @returns {NextResponse | null}
 */
export function assertChooserEdit(user, orgId) {
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!orgId) {
    return NextResponse.json({ success: false, error: 'organization_id is required' }, { status: 400 })
  }
  if (user.isMaster) return null
  // owner-location orgs ∪ org_admin grants — owner-WITHIN-the-org only.
  if (getOwnerOrganizationIds(user).includes(orgId)) return null
  if (orgReachable(user, orgId)) {
    return NextResponse.json({ success: false, error: 'Owner or organization admin required' }, { status: 403 })
  }
  return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
}
