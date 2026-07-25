// /api/contract-templates/[id]/versions
//   GET   list archived body/variables snapshots for one template,
//         newest version first (master / owner of the template's org)
//
// CONTRACTS-TPLVER.1 (mig 446): PATCH /api/contract-templates/[id]
// archives the pre-overwrite row into contract_template_versions
// before bumping `version`. This route is the read side.
//
// Same guard + org scoping as the parent template GET (SAAS-5): this
// route runs as service-role (RLS bypassed), so the mig 106 "owner
// sees their org" model is replicated in app code, not left to RLS.
// We resolve the parent template first (org-scoped) so a foreign or
// missing template_id 404s before we even query the versions table —
// foreign and missing ids collapse into the same 404 so ids can't be
// enumerated across tenants.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getOwnerOrganizationIds } from '@/lib/auth'

export const runtime = 'nodejs'

// Master, the owner role, or any caller who owns at least one org.
// Mirrors canManageTemplates() in ../route.js — kept as a local copy
// (matches the sibling-subresource convention elsewhere, e.g.
// /api/races/[id]/teams's local loadRaceForAccess()) rather than a
// cross-route import.
function canManageTemplates(user) {
  return user?.role === 'master' || user?.role === 'owner'
    || getOwnerOrganizationIds(user).length > 0
}

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canManageTemplates(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  const db = createServerClient()
  let templateQuery = db
    .from('contract_templates')
    .select('id')
    .eq('id', params.id)
  if (!user.isMaster) {
    // Org scoping (mirrors the parent template GET). NULL
    // organization_id never matches `.in`, so unanchored templates
    // 404 for non-masters. An owner of no org can match nothing —
    // 404 without querying.
    const ownerOrgIds = getOwnerOrganizationIds(user)
    if (ownerOrgIds.length === 0) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    templateQuery = templateQuery.in('organization_id', ownerOrgIds)
  }
  const { data: template, error: templateErr } = await templateQuery.maybeSingle()
  if (templateErr) return NextResponse.json({ success: false, error: templateErr.message }, { status: 500 })
  if (!template) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const { data, error } = await db
    .from('contract_template_versions')
    .select('id, version, body_markdown, variables_schema, changed_by, created_at')
    .eq('template_id', params.id)
    .order('version', { ascending: false })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || [] })
}
