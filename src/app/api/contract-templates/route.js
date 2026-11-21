// /api/contract-templates
//   GET   list templates the caller can administer (master sees
//         all; an org admin sees the orgs they administer — C18 ORGROLE.1).
//   POST  create a new template (master / org admin of the active org).
//
// Templates are master/org-admin-only artefacts — staff and contractors
// never see them. The issue wizard surfaces them only through this
// authorised route.
//
// withAuth only signs the caller in (the same 401); the contract gates and
// the org scoping stay below in their old order with their old texts.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { adminOrganizationIds } from '@/lib/org-admin'
import { canManageContractsInOrg, canManageContractsSomewhere } from '@/lib/contract-gates'
import { contractTemplateSchema } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'

export const GET = withAuth({ permission: null, location: false }, async ({ user, db }) => {  // GATES-3 (c) — the issue wizard's list. The rows are scoped to the orgs the
  // caller manages below, so the gate is GATES-2's coarse rule (an org admin
  // of SOME org; C18 ORGROLE.1), not the ACTIVE studio's role: an owner of another org
  // working from a studio where they are a manager got a 403 and an empty
  // wizard.
  if (!canManageContractsSomewhere(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  // This route runs as service-role (RLS bypassed), so the mig 106
  // "owner sees their org" model must be replicated in app code —
  // otherwise any owner reads every org's templates (incl. comp body
  // copy). Master sees all; a non-master is scoped to the orgs they
  // administer.
  let query = db
    .from('contract_templates')
    .select('id, organization_id, name, description, body_markdown, variables_schema, employment_type, version, active, created_at, updated_at')
    .order('updated_at', { ascending: false })

  // C18 ORGROLE.1 — the orgs the caller ADMINISTERS (an org_admin grant), the
  // set POST /api/contracts issues from. getOwnerOrganizationIds (any studio
  // owner role) listed another org's templates that the issue then 404'd.
  if (!user.isMaster) {
    const adminOrgIds = adminOrganizationIds(user)
    if (adminOrgIds.length === 0) {
      return NextResponse.json({ success: true, data: [] })
    }
    query = query.in('organization_id', adminOrgIds)
  }

  const { data, error } = await query
  if (error) {
    logError('contract-templates', 'template list failed', { err: error })
    return NextResponse.json({ success: false, error: 'Could not load the templates. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data })
})

export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {  // GATES-2 — the template is created in the ACTIVE org (below), so that is
  // the org the caller must manage. isOwnerOrMaster let any org admin through
  // (an admin of X created templates in Y, where they are a manager) and
  // refused nobody the org check would have caught.
  if (!canManageContractsInOrg(user, user.activeOrganization?.id || null)) {
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

  const { data, error } = await db
    .from('contract_templates')
    .insert({
      ...parsed.data,
      organization_id: orgId,
      created_by: user.id,
    })
    .select()
    .single()
  if (error) {
    logError('contract-templates', 'template create failed', { orgId, err: error })
    return NextResponse.json({ success: false, error: 'Could not create the template. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data })
})
