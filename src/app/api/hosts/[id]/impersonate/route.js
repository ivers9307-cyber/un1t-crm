// POST /api/hosts/[id]/impersonate — start an admin view-as-host session.
// ADMIN_ROLES; the host must be in the caller's org. (HOST-PORTAL.4)
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { ADMIN_ROLES } from '@/lib/schemas'
import { loadHostForOrg } from '@/lib/hosts'
import { startHostImpersonation } from '@/lib/host-impersonation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Same order as before: 401, then ADMIN_ROLES on user.role (403), then an
// active org (400), then the host in that org (404). The log row and the
// un1t_host_impersonate cookie are written by startHostImpersonation, unchanged.
export const POST = withAuth(
  { permission: null, location: false, roles: ADMIN_ROLES, forbiddenMessage: 'Manager+ required' },
  async ({ user, db, request, params }) => {
    const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
    if (!orgId) return NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 })

    const host = await loadHostForOrg(db, params?.id, orgId)
    if (!host) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

    await startHostImpersonation({
      adminUserId: user.id,
      hostId: host.id,
      organizationId: orgId,
      ip: request.headers.get('x-forwarded-for') || null,
      userAgent: request.headers.get('user-agent') || null,
    })
    return NextResponse.json({ success: true, data: { hostId: host.id } })
  },
)
