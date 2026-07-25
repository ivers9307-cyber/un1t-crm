// /api/contracts/[id]/resend
//
// CONTRACTS-EDIT.1 — re-fire the issue-notification email (+ push)
// for a contract that's still awaiting signature. Useful when the
// original send failed silently (the issue route's `warning` was
// easy to miss before ContractIssueWarningBanner) or the recipient
// just says "I never got it". Never mutates the contract row —
// this is a pure notification replay.
//
// Guard mirrors /api/contracts/[id]/revoke exactly:
//   - caller is master or owner
//   - org-scoped (404 not 403 for a foreign-org id — non-enumerable)
//   - status must be 'issued' or 'viewed' (409 otherwise)

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getOwnerOrganizationIds } from '@/lib/auth'
import { sendContractIssuedEmail } from '@/lib/contracts-email'
import { sendPush } from '@/lib/push'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner'
}

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isOwnerOrMaster(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: contract, error: cErr } = await db
    .from('contracts')
    .select(`
      id, status, organization_id, location_id, profile_id,
      profile:profiles!profile_id (full_name, email),
      issuer:profiles!issued_by (full_name),
      template:contract_templates!template_id (name)
    `)
    .eq('id', params.id)
    .maybeSingle()
  if (cErr) return NextResponse.json({ success: false, error: cErr.message }, { status: 500 })
  if (!contract) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  // Service-role read bypasses RLS — an owner must only be able to
  // resend contracts in an org they own. 404 (not 403) so a non-owner
  // can't enumerate which contract ids exist in another tenant.
  if (!user.isMaster && !getOwnerOrganizationIds(user).includes(contract.organization_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (contract.status !== 'issued' && contract.status !== 'viewed') {
    return NextResponse.json({
      success: false,
      error: `Cannot resend a contract in status '${contract.status}'. Only unsigned contracts can be resent.`,
    }, { status: 409 })
  }

  const emailResult = await sendContractIssuedEmail({
    contract,
    recipient: { full_name: contract.profile?.full_name, email: contract.profile?.email },
    issuer: { full_name: contract.issuer?.full_name },
    templateName: contract.template?.name,
  })

  // Push notification (best effort, mirrors the issue route's block).
  try {
    await sendPush([contract.profile_id], {
      title: 'Contract awaiting signature',
      body: contract.template?.name
        ? `${user.full_name || 'UN1T'} sent you a reminder to sign "${contract.template.name}".`
        : `${user.full_name || 'UN1T'} sent you a reminder to sign your contract.`,
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

  // AUDIT-EXPAND.1 — record the resend in the unified log.
  await logAuditEvent({
    category: 'business',
    action: 'contract.resent',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: {
      id: contract.profile_id,
      label: contract.profile?.full_name || null,
      resource: `contracts/${contract.id}`,
    },
    locationId: contract.location_id || null,
    details: {
      template_name: contract.template?.name || null,
    },
    request,
  })

  return NextResponse.json({
    success: true,
    warning: emailResult.ok ? undefined : `Email could not be sent: ${emailResult.error}`,
  })
}
