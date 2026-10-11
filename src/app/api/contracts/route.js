// /api/contracts
//   GET   role-aware list:
//           recipient (any role) → only their own
//           org admin            → contracts in the orgs they administer
//                                  (C18 ORGROLE.1: an org_admin grant; a
//                                  studio owner is not one)
//           master               → everything
//   POST  issue a new contract (master / org admin of the template's org). Body:
//         { template_id, profile_id, location_id?, variables, issuer_signature }
//
// Issue path:
//   1. Validate the issuer is a master or an org admin (contract-gates).
//   2. Look up the template (must be active, employment_type
//      compatible with the recipient's profile).
//   3. Look up the recipient's primary location → org_id (if not
//      explicitly supplied).
//   4. Validate the template's required custom variables are
//      present.
//   5. Render the body with the merged variable map.
//   6. Insert with status='issued', issued_at=now(), issuer
//      countersignature stored. PDF generation is deferred to the
//      sign step (no PDF until the recipient actually signs — at
//      that point we have both signatures and can produce the
//      final dual-signed PDF).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { adminOrganizationIds } from '@/lib/org-admin'
import { canManageContractsInOrg, canManageContractsSomewhere } from '@/lib/contract-gates'
import { contractIssueSchema } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'
import {
  mergeVariables,
  renderTemplate,
  validateCustomVariables,
  extractPlaceholders,
  locationVariables,
} from '@/lib/contracts'
import { getLocationBranding } from '@/lib/location-branding'
import { getContractingEntity } from '@/lib/contracting-entity'
import { notifyContractIssued } from '@/lib/contracts-notify'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // C1 (2026-06 platform audit): this route uses createServerClient()
  // (service role), which BYPASSES RLS — the policies in mig 106 only
  // bind the `authenticated` role, so there is no DB-side filter here.
  // We must replicate mig 106's visibility model in the app layer:
  //   master  → every contract
  //   else    → contracts they received (profile_id) OR that belong to
  //             an organization they own (mig 051 owner role → mig 079
  //             organization_id).
  // Without this, any authenticated staff member could read every
  // contract's variables_data (salary/comp), signature_value and
  // signed_ip across all tenants.
  const db = createServerClient()
  let query = db
    .from('contracts')
    .select(`
      id, template_id, profile_id, location_id, organization_id,
      status, issued_at, issued_by, signed_at, declined_at, revoked_at,
      profile:profiles!profile_id (full_name, email, role, employment_type),
      template:contract_templates!template_id (name, employment_type)
    `)
    .order('issued_at', { ascending: false })

  // CONTRACTS-DRAFT.1 — a draft is only visible to the org/issuer
  // side (the organization_id arm below); the recipient must NEVER
  // see it in their own list (this is the route mobile's
  // listContracts() hits for "my contracts" — recipients would
  // otherwise see a contract that was never actually sent to them).
  // The org-owner arm is unaffected: an owner reviewing their org's
  // contracts still needs to see drafts to send/discard them.
  // C18 ORGROLE.1 (Richard, 1 Oct 2026): the org arm is the orgs the caller
  // ADMINISTERS (an org_admin grant), the rule of GET /api/contracts/[id] and
  // every contract action. It used to be getOwnerOrganizationIds (any studio
  // owner role), so a studio owner's list (mobile's "my contracts" too) held
  // org rows whose detail answered 404.
  if (!user.isMaster) {
    const adminOrgIds = adminOrganizationIds(user)
    if (adminOrgIds.length > 0) {
      query = query.or(
        `and(profile_id.eq.${user.id},status.neq.draft),organization_id.in.(${adminOrgIds.join(',')})`
      )
    } else {
      query = query.eq('profile_id', user.id).neq('status', 'draft')
    }
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  // GATES-3 (c) — the coarse pre-check is GATES-2's: master, or an org admin
  // of SOME org (C18 ORGROLE.1: an org_admin grant, not a studio owner role). `user.role` is the ACTIVE studio's
  // role, so it refused an owner of the template's org working from a studio
  // where they are a manager, and an org admin whose own role there is not
  // owner. The decision is the template's org, below.
  if (!canManageContractsSomewhere(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  const validation = await validateBody(request, contractIssueSchema)
  if (!validation.ok) return validation.response
  const parsed = { data: validation.data }

  const db = createServerClient()

  // 1. Template — must be active and either match the recipient's
  //    employment type or be 'both'. We pull the body + schema for
  //    rendering.
  const { data: template, error: tErr } = await db
    .from('contract_templates')
    .select('id, organization_id, body_markdown, variables_schema, employment_type, active')
    .eq('id', parsed.data.template_id)
    .maybeSingle()
  if (tErr) return NextResponse.json({ success: false, error: tErr.message }, { status: 500 })
  if (!template) return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })

  // 1a. SAAS-5 — org-scope the template pick. The service-role read
  //     above bypasses RLS, so without this any owner could issue from
  //     another org's template — rendering its body (comp copy) AND
  //     anchoring the new contract to that org via
  //     template.organization_id in step 3. Non-master issuers may
  //     only use templates in an org they own; a NULL organization_id
  //     template is master-only. Same 404 as a missing template so
  //     foreign ids can't be probed (this must precede the `active`
  //     check for the same reason).
  //     GATES-3: canManageContractsInOrg is that same rule (master, or an
  //     org admin of the org; a null org is master-only. C18 ORGROLE.1).
  if (!canManageContractsInOrg(user, template.organization_id)) {
    return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
  }

  if (!template.active) return NextResponse.json({ success: false, error: 'Template is inactive' }, { status: 400 })

  // 2. Recipient — pull their compensation fields and primary
  //    location's org_id so we know what org_id to anchor the
  //    contract to. Service-role select bypasses recipient-self
  //    RLS so the issuer can fetch this.
  const { data: recipient, error: rErr } = await db
    .from('profiles')
    .select(`
      id, full_name, email, role, employment_type,
      annual_salary, hourly_rate, overtime_rate, contracted_hours_per_week,
      profile_locations:profile_locations(location_id, is_default,
        location:locations!location_id(id, organization_id, name, address, phone, email))
    `)
    .eq('id', parsed.data.profile_id)
    .maybeSingle()
  if (rErr) return NextResponse.json({ success: false, error: rErr.message }, { status: 500 })
  if (!recipient) return NextResponse.json({ success: false, error: 'Recipient not found' }, { status: 404 })

  // 2a. C140 CONTRACTRECIPIENT.1 (security) — the recipient must belong to the
  //     template's org. Only the template's org was judged against the issuer,
  //     so an owner of org A could issue A's template to a person in org B and
  //     the contract rendered B's person (name, email, pay). A template with an
  //     org needs a recipient with a studio in it; anyone else is the same 404
  //     as an unknown id, before any other check reads their row, so other
  //     orgs' people cannot be probed. A null-org
  //     template (master-only) keeps its old behaviour.
  const allLinks = recipient.profile_locations || []
  const recipientLinks = template.organization_id
    ? allLinks.filter(l => l?.location?.organization_id === template.organization_id)
    : allLinks
  if (template.organization_id && recipientLinks.length === 0) {
    return NextResponse.json({ success: false, error: 'Recipient not found' }, { status: 404 })
  }

  // Employment-type sanity check — block issuing an FTE-only template
  // to a contractor and vice versa. 'both' templates always pass.
  if (template.employment_type !== 'both'
      && template.employment_type !== recipient.employment_type) {
    return NextResponse.json({
      success: false,
      error: `Template is for ${template.employment_type} but recipient is ${recipient.employment_type || 'unknown'}.`,
    }, { status: 400 })
  }

  // 3. Resolve location_id + org_id. C140: the studio is one of the
  //    recipient's studios IN the template's org (their default there first);
  //    an explicit location_id outside them is refused.
  let locationId = parsed.data.location_id || null
  let organizationId = template.organization_id || null
  if (locationId && template.organization_id && !recipientLinks.some(l => l.location_id === locationId)) {
    return NextResponse.json({
      success: false,
      error: 'That location is not one of the recipient\'s studios in this template\'s organisation.',
    }, { status: 400 })
  }
  if (!locationId) {
    const def = recipientLinks.find(l => l.is_default) || recipientLinks[0]
    locationId = def?.location_id || null
  }
  if (!organizationId) {
    const link = recipientLinks.find(l => l.location_id === locationId)
      || recipientLinks[0]
    organizationId = link?.location?.organization_id || null
  }
  if (!organizationId) {
    return NextResponse.json({
      success: false,
      error: 'Cannot resolve organisation for this contract — recipient has no location memberships.',
    }, { status: 400 })
  }

  // 3a. CONTRACTS-VARS.2 — location auto-fill variables. Resolve the
  //     SAME location row already picked above as locationId (falls
  //     through to {} fields if an explicit request-body location_id
  //     isn't actually one of the recipient's own links — an edge case
  //     that just means fewer location vars resolve, not an error).
  //     Branding is company_settings -> org_settings -> locations.name
  //     inheritance (see getLocationBranding); fetch once, reused by the
  //     render below.
  const locationRow = recipientLinks.find(l => l.location_id === locationId)?.location || null
  const branding = await getLocationBranding(db, locationId)
  //     LEGALENT.1 — {{legal_entity_name}} is the CONTRACTING COMPANY
  //     (org_settings.legal_entity_name, mig 425), which is what a
  //     party clause must name; company_name stays the brand. Resolved
  //     against the org already established above, so a CCF Autos
  //     contract can never inherit the gym's entity.
  const entity = await getContractingEntity(db, { organizationId, locationId, branding })
  //     W1.S1a — never issue (or draft) a contract without a contracting
  //     entity. Since the literal sweep the resolver's floor is the org's
  //     own name, then '' when even that row is unreadable. A row stored
  //     without legal_entity_name reads as pre-LEGALENT.1 to
  //     contractCountersignatureLabel and would countersign as the legacy
  //     entity on every surface and the archived PDF, for good. Refuse
  //     before any insert; the operator retries.
  if (!String(entity?.label || '').trim()) {
    return NextResponse.json({
      success: false,
      error: "Couldn't confirm the contracting company for this organisation. Nothing was issued; please try again.",
    }, { status: 503 })
  }
  const locVars = locationVariables({ location: locationRow, branding, entity })

  // 4. Validate custom variables required by the template.
  const customCheck = validateCustomVariables(template.variables_schema, parsed.data.variables)
  if (!customCheck.ok) {
    return NextResponse.json({
      success: false,
      error: `Missing required variables: ${customCheck.missing.join(', ')}`,
    }, { status: 400 })
  }

  // 5. Render — merge profile auto-fills, location auto-fills, and
  //    custom variables (in that priority — custom always wins), then
  //    substitute. body_rendered is what gets stored; the recipient
  //    sees this exact text on their signing page. Location vars are
  //    folded into the "custom" argument here (mergeVariables' own
  //    signature stays profile/custom) so a same-named custom variable
  //    can still override a location auto-fill if a template ever
  //    declares one.
  const merged = mergeVariables(recipient, { ...locVars, ...parsed.data.variables })
  let bodyRendered = renderTemplate(template.body_markdown, merged)

  // 5a. CONTRACT-VARS.1 — reject if any placeholder remains in the
  //     rendered body. Location placeholders were already substituted
  //     above (locVars is folded into `merged` before this render), so
  //     no assumeKeys are needed here — by the time we reach this
  //     check the rendered text genuinely contains no location
  //     placeholders to account for. The wizard surfaces any OTHER
  //     unresolved placeholder in step 2 as an "Unmapped variables"
  //     form, so an issuer who's made it this far has had a chance to
  //     fill them in. This server check is the safety net for any
  //     other client (API consumer, bulk script, future mobile-issuer
  //     flow) that might miss it.
  const leftover = extractPlaceholders(bodyRendered)
  if (leftover.length > 0) {
    return NextResponse.json({
      success: false,
      error: `Unmapped variables in the rendered body: ${leftover.map((k) => `{{${k}}}`).join(', ')}. Fill values for each before issuing.`,
      unmapped_keys: leftover,
    }, { status: 400 })
  }

  // 5b. CONTRACTS-EDIT.1 — per-contract body override. The issuer may
  //     hand-edit the rendered text in the wizard's step-3 preview
  //     (a one-off clause tweak) without touching the shared
  //     template. When present it REPLACES bodyRendered entirely;
  //     variables_data still stores the merged auto-fill + custom
  //     map either way (kept for audit/reference even though the
  //     literal stored text now diverges from a fresh render of that
  //     map). Re-run the same leftover check against the override —
  //     a hand-edit can just as easily introduce or leave behind a
  //     stray {{placeholder}} as the template render could.
  let bodyEdited = false
  if (parsed.data.body_override) {
    const overrideLeftover = extractPlaceholders(parsed.data.body_override)
    if (overrideLeftover.length > 0) {
      return NextResponse.json({
        success: false,
        error: `Unmapped variables in the rendered body: ${overrideLeftover.map((k) => `{{${k}}}`).join(', ')}. Fill values for each before issuing.`,
        unmapped_keys: overrideLeftover,
      }, { status: 400 })
    }
    bodyRendered = parsed.data.body_override
    bodyEdited = true
  }

  // CONTRACTS-DRAFT.1 — save_as_draft skips the notification path
  // entirely; the recipient must never know a draft exists until an
  // issuer explicitly sends it (/api/contracts/[id]/send) or it's
  // dropped (/api/contracts/[id]/discard). status otherwise defaults
  // to 'issued' via the column default.
  const isDraft = !!parsed.data.save_as_draft
  const insertRow = {
    template_id: template.id,
    profile_id: recipient.id,
    location_id: locationId,
    organization_id: organizationId,
    variables_data: merged,
    body_rendered: bodyRendered,
    issued_by: user.id,
    issuer_signature: parsed.data.issuer_signature,
  }
  if (isDraft) insertRow.status = 'draft'

  // 6. Insert.
  const { data: contract, error: insErr } = await db
    .from('contracts')
    .insert(insertRow)
    .select()
    .single()
  if (insErr) return NextResponse.json({ success: false, error: insErr.message }, { status: 500 })

  // Look up template name for the audit details. Best-effort — the
  // contract is already in the DB either way.
  const { data: tplRow } = await db
    .from('contract_templates')
    .select('name')
    .eq('id', template.id)
    .maybeSingle()

  // AUDIT-EXPAND.1 — record the contract issue/draft in the unified
  // log. CONTRACTS-DRAFT.1 — a saved draft logs contract.drafted
  // instead of contract.issued so the trail reads correctly.
  await logAuditEvent({
    category: 'business',
    action: isDraft ? 'contract.drafted' : 'contract.issued',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: {
      id: recipient.id,
      label: recipient.full_name,
      resource: `contracts/${contract.id}`,
    },
    locationId,
    details: {
      template_id: template.id,
      template_name: tplRow?.name || null,
      body_edited: bodyEdited,
    },
    request,
  })

  // CONTRACTS-DRAFT.1 — a draft is never emailed or pushed; `warning`
  // stays undefined (there's nothing to warn about — nothing was
  // attempted).
  if (isDraft) {
    return NextResponse.json({ success: true, data: contract })
  }

  const { emailResult } = await notifyContractIssued({
    db,
    contract: { ...contract, profile: { full_name: recipient.full_name, email: recipient.email } },
    issuer: { full_name: user.full_name },
  })

  return NextResponse.json({
    success: true,
    data: contract,
    warning: emailResult.ok ? undefined : `Contract issued but email could not be sent: ${emailResult.error}`,
  })
}
