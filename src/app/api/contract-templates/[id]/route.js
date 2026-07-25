// /api/contract-templates/[id]
//   GET     fetch one template (master / owner of the template's org)
//   PATCH   update (master / owner of the template's org)
//   DELETE  soft-delete (active=false). We don't hard-delete because
//           contracts.template_id has on delete restrict — issued
//           contracts must keep their template-row anchor for audit.
//
// SAAS-5: this route runs as service-role (RLS bypassed), so the
// mig 106 "owner sees their org" model must be replicated in app code
// — same as the list route. Non-master callers are scoped to the orgs
// they own via `.in('organization_id', ...)` on every read AND write;
// foreign and missing ids collapse into the same 404 so template ids
// can't be enumerated across tenants. A template with NULL
// organization_id is deliberately master-only for detail ops: NULL
// never matches an `.in(...)` membership filter.
//
// CONTRACTS-TPLVER.1 (mig 446): a body_markdown PATCH archives the
// pre-overwrite row into contract_template_versions before bumping
// `version` — history used to be write-only. An archive failure
// aborts the PATCH (500) rather than proceeding to the update, so the
// version counter can never outrun its own audit trail. See
// GET /api/contract-templates/[id]/versions for the read side.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getOwnerOrganizationIds } from '@/lib/auth'
import { contractTemplateSchema } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'

// Master, the owner role, or any caller who owns at least one org.
// The membership arm matters for composability: SAAS-4 extends
// getOwnerOrganizationIds() to org-admin grants, and those callers
// must clear this gate without carrying the 'owner' role label.
// The org filter below still does the real per-row work.
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
  let query = db
    .from('contract_templates')
    .select('*')
    .eq('id', params.id)
  if (!user.isMaster) {
    // Org scoping (mirrors the list route). NULL organization_id never
    // matches `.in`, so unanchored templates 404 for non-masters. An
    // owner of no org can match nothing — 404 without querying.
    const ownerOrgIds = getOwnerOrganizationIds(user)
    if (ownerOrgIds.length === 0) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    query = query.in('organization_id', ownerOrgIds)
  }
  const { data, error } = await query.maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, data })
}

export async function PATCH(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canManageTemplates(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  // Accept partial updates — re-use the schema with `.partial()` so
  // the wizard can patch a single field (toggle active, rename, etc.)
  // without resending the full body.
  const validation = await validateBody(request, contractTemplateSchema.partial(), { allowEmpty: true })
  if (!validation.ok) return validation.response
  const parsed = { data: validation.data }

  // Resolve the caller's org scope once — it constrains BOTH the
  // version preflight and the UPDATE itself, so even a race between
  // the two can't let the write land on a foreign row.
  const ownerOrgIds = user.isMaster ? null : getOwnerOrganizationIds(user)
  if (ownerOrgIds && ownerOrgIds.length === 0) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const db = createServerClient()

  // Bump version when the body changes — preserves the audit trail
  // that the issued contracts were rendered against an older
  // template body. Toggle of active/name/description doesn't bump.
  const updates = { ...parsed.data }
  if (parsed.data.body_markdown !== undefined) {
    // We can't compute the new version atomically from the patch
    // payload without a SELECT first; do a tiny preflight read —
    // org-scoped, so a foreign template 404s here without even
    // revealing that the id exists. Also pulls the fields we need to
    // archive the pre-overwrite state (CONTRACTS-TPLVER.1).
    let preflight = db
      .from('contract_templates')
      .select('version, body_markdown, variables_schema')
      .eq('id', params.id)
    if (ownerOrgIds) preflight = preflight.in('organization_id', ownerOrgIds)
    const { data: current, error: curErr } = await preflight.maybeSingle()
    if (curErr) return NextResponse.json({ success: false, error: curErr.message }, { status: 500 })
    if (!current) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    updates.version = (current.version || 1) + 1

    // Archive the OLD body/variables BEFORE overwriting — history was
    // previously write-only (the old body was simply lost on bump).
    // ignoreDuplicates makes a retry of this exact archive a no-op
    // rather than an error; a failure here aborts the PATCH entirely
    // so the version bump never outruns its own audit trail.
    const { error: archiveErr } = await db
      .from('contract_template_versions')
      .upsert({
        template_id: params.id,
        version: current.version,
        body_markdown: current.body_markdown,
        variables_schema: current.variables_schema,
        changed_by: user.id,
      }, { onConflict: 'template_id,version', ignoreDuplicates: true })
    if (archiveErr) {
      return NextResponse.json({ success: false, error: archiveErr.message }, { status: 500 })
    }
  }

  let update = db
    .from('contract_templates')
    .update(updates)
    .eq('id', params.id)
  if (ownerOrgIds) update = update.in('organization_id', ownerOrgIds)
  const { data, error } = await update.select().maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  // No row matched → missing id or a foreign/NULL-org template; same 404.
  if (!data) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, data })
}

export async function DELETE(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canManageTemplates(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }
  // Soft-delete via active=false. Hard-delete would fail on the
  // FK (contracts.template_id on delete restrict) the moment a
  // template has been used. Soft-delete keeps issued contracts
  // intact while removing the template from the issue picker.
  const db = createServerClient()
  let update = db
    .from('contract_templates')
    .update({ active: false })
    .eq('id', params.id)
  if (!user.isMaster) {
    // Same org scoping as GET/PATCH, applied to the write itself so
    // there is no read-then-write window to race.
    const ownerOrgIds = getOwnerOrganizationIds(user)
    if (ownerOrgIds.length === 0) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    update = update.in('organization_id', ownerOrgIds)
  }
  const { data, error } = await update.select('id')
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!data || data.length === 0) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json({ success: true })
}
