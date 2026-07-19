// /api/contract-templates
//   GET   list templates the caller can administer (master sees
//         all; owner sees their org). RLS enforces visibility too.
//   POST  create a new template (master/owner only).
//
// Templates are master/owner-only artefacts — staff and contractors
// never see them. The issue wizard surfaces them only through this
// authorised route.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getOwnerOrganizationIds } from '@/lib/auth'
import { contractTemplateSchema } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'

function isOwnerOrMaster(user) {
  // SAAS-4: org admins (mig 411) count — they act as owner across
  // their whole org, and getOwnerOrganizationIds() below already
  // scopes them to exactly their admin orgs. The role check alone
  // would usually pass anyway (their active-location role resolves to
  // the synthetic 'owner'), but an org admin holding an explicit
  // non-owner assignment at their active location must not be locked
  // out of their org's templates.
  return user?.role === 'master' || user?.role === 'owner'
    || (user?.orgAdminOrgIds || []).length > 0
}

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isOwnerOrMaster(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  // This route runs as service-role (RLS bypassed), so the mig 106
  // "owner sees their org" model must be replicated in app code —
  // otherwise any owner reads every org's templates (incl. comp body
  // copy). Master sees all; a non-master is scoped to the orgs they
  // own, and an owner of no org sees nothing.
  const db = createServerClient()
  let query = db
    .from('contract_templates')
    .select('id, organization_id, name, description, body_markdown, variables_schema, employment_type, version, active, created_at, updated_at')
    .order('updated_at', { ascending: false })

  if (!user.isMaster) {
    const ownerOrgIds = getOwnerOrganizationIds(user)
    if (ownerOrgIds.length === 0) {
      return NextResponse.json({ success: true, data: [] })
    }
    query = query.in('organization_id', ownerOrgIds)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isOwnerOrMaster(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  const validation = await validateBody(request, contractTemplateSchema)
  if (!validation.ok) return validation.response
  const parsed = { data: validation.data }

  // Anchor the template to the issuer's active organisation.
  // Master without an active org context can pick during edit;
  // we still store organization_id from activeOrganization when
  // present so the org-scoped owner RLS works for non-master
  // collaborators on the same org.
  const orgId = user.activeOrganization?.id || null

  const db = createServerClient()
  const { data, error } = await db
    .from('contract_templates')
    .insert({
      ...parsed.data,
      organization_id: orgId,
      created_by: user.id,
    })
    .select()
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data })
}
