// POST /api/hosts/[id]/impersonate — start an admin view-as-host session.
// ADMIN_ROLES; the host must be in the caller's org. (HOST-PORTAL.4)
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { ADMIN_ROLES } from '@/lib/schemas'
import { loadHostForOrg } from '@/lib/hosts'
import { startHostImpersonation } from '@/lib/host-impersonation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.includes(user.role)) return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 })

  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  await startHostImpersonation({
    adminUserId: user.id,
    hostId: host.id,
    organizationId: orgId,
    ip: request.headers.get('x-forwarded-for') || null,
    userAgent: request.headers.get('user-agent') || null,
  })
  return NextResponse.json({ success: true, data: { hostId: host.id } })
}
