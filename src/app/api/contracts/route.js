// /api/contracts
//   GET   role-aware list:
//           recipient (any role) → only their own
//           owner                → contracts in their org
//           master               → everything
//   POST  issue a new contract (master/owner only). Body:
//         { template_id, profile_id, location_id?, variables, issuer_signature }
//
// Issue path:
//   1. Validate the issuer is master/owner.
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
import { contractIssueSchema } from '@/lib/schemas'
import {
  mergeVariables,
  renderTemplate,
  validateCustomVariables,
} from '@/lib/contracts'
import { sendContractIssuedEmail } from '@/lib/contracts-email'
import { sendPush } from '@/lib/push'

export const runtime = 'nodejs'

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner'
}

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Visibility is enforced by RLS (recipient sees own; master sees
  // all; owner sees org). We just SELECT and let the policy filter.
  const db = createServerClient()
  const { data, error } = await db
    .from('contracts')
    .select(`
      id, template_id, profile_id, location_id, organization_id,
      status, issued_at, issued_by, signed_at, declined_at, revoked_at,
      profile:profiles!profile_id (full_name, email, role, employment_type),
      template:contract_templates!template_id (name, employment_type)
    `)
    .order('issued_at', { ascending: false })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isOwnerOrMaster(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  const raw = await request.json().catch(() => ({}))
  const parsed = contractIssueSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

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
        location:locations!location_id(id, organization_id))
    `)
    .eq('id', parsed.data.profile_id)
    .maybeSingle()
  if (rErr) return NextResponse.json({ success: false, error: rErr.message }, { status: 500 })
  if (!recipient) return NextResponse.json({ success: false, error: 'Recipient not found' }, { status: 404 })

  // Employment-type sanity check — block issuing an FTE-only template
  // to a contractor and vice versa. 'both' templates always pass.
  if (template.employment_type !== 'both'
      && template.employment_type !== recipient.employment_type) {
    return NextResponse.json({
      success: false,
      error: `Template is for ${template.employment_type} but recipient is ${recipient.employment_type || 'unknown'}.`,
    }, { status: 400 })
  }

  // 3. Resolve location_id + org_id.
  let locationId = parsed.data.location_id || null
  let organizationId = template.organization_id || null
  const recipientLinks = recipient.profile_locations || []
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

  // 4. Validate custom variables required by the template.
  const customCheck = validateCustomVariables(template.variables_schema, parsed.data.variables)
  if (!customCheck.ok) {
    return NextResponse.json({
      success: false,
      error: `Missing required variables: ${customCheck.missing.join(', ')}`,
    }, { status: 400 })
  }

  // 5. Render — merge profile auto-fills + custom variables, then
  //    substitute. body_rendered is what gets stored; the recipient
  //    sees this exact text on their signing page.
  const merged = mergeVariables(recipient, parsed.data.variables)
  const bodyRendered = renderTemplate(template.body_markdown, merged)

  // 6. Insert. status defaults to 'issued' via the column default.
  const { data: contract, error: insErr } = await db
    .from('contracts')
    .insert({
      template_id: template.id,
      profile_id: recipient.id,
      location_id: locationId,
      organization_id: organizationId,
      variables_data: merged,
      body_rendered: bodyRendered,
      issued_by: user.id,
      issuer_signature: parsed.data.issuer_signature,
    })
    .select()
    .single()
  if (insErr) return NextResponse.json({ success: false, error: insErr.message }, { status: 500 })

  // Look up template name for the email subject. Best-effort —
  // the contract is already in the DB; an email failure surfaces
  // as a warning but doesn't roll back the issue.
  const { data: tplRow } = await db
    .from('contract_templates')
    .select('name')
    .eq('id', template.id)
    .maybeSingle()

  const emailResult = await sendContractIssuedEmail({
    contract,
    recipient: { full_name: recipient.full_name, email: recipient.email },
    issuer: { full_name: user.full_name },
    templateName: tplRow?.name,
  })

  // Push notification (best effort, never blocks). sendPush honours
  // the recipient's permissions.mobile.push_notifications master
  // switch + their notify_contract_issued category toggle. If the
  // mobile app isn't installed (no device tokens) it's a quiet
  // no-op. Tap deep-links to /contracts/<id> via expo-router so
  // the recipient lands directly on the sign screen.
  try {
    await sendPush([recipient.id], {
      title: 'Contract awaiting signature',
      body: tplRow?.name
        ? `${user.full_name || 'UN1T'} issued you "${tplRow.name}" — tap to review and sign.`
        : `${user.full_name || 'UN1T'} issued you a contract — tap to review and sign.`,
      category: 'contract_issued',
      data: {
        type: 'contract_issued',
        contract_id: contract.id,
        path: `/contracts/${contract.id}`,
      },
    })
  } catch {
    // Push is non-blocking; intentionally swallow.
  }

  return NextResponse.json({
    success: true,
    data: contract,
    warning: emailResult.ok ? undefined : `Contract issued but email could not be sent: ${emailResult.error}`,
  })
}
