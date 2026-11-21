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
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { canManageContractsInOrg, canManageContractsSomewhere } from '@/lib/contract-gates'
import { sendContractIssuedEmail } from '@/lib/contracts-email'
import { sendPush } from '@/lib/push'
import { contractPushSender, contractPushBody } from '@/lib/contracts-notify'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'

// sendContractIssuedEmail's own refusal is safe to show; a provider's text is not.
const emailProblem = (err) => (err === 'No recipient email' ? err : 'the email service did not accept it')

// withAuth only signs the caller in (the same 401); the coarse 403, the org 404
// and the status 409 stay by hand, in their old order.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  // GATES-2 — coarse only (master, or owner/admin of SOME org). It asked
  // user.role, the ACTIVE studio's role, which refused an owner of the
  // contract's org working from another studio. The decision is below.
  if (!canManageContractsSomewhere(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  const { data: contract, error: cErr } = await db
    .from('contracts')
    .select(`
      id, status, organization_id, location_id, profile_id,
      profile:profiles!profile_id (full_name, email),
      issuer:profiles!issued_by (full_name),
      template:contract_templates!template_id (name)
    `)
    .eq('id', params?.id)
    .maybeSingle()
  if (cErr) {
    logError('contracts', 'contract read failed (resend)', { contractId: params?.id, code: cErr.code || null, err: cErr.message })
    return NextResponse.json({ success: false, error: 'Could not load the contract.' }, { status: 500 })
  }
  if (!contract) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  // Service-role read bypasses RLS — an owner must only be able to
  // resend contracts in an org they own. 404 (not 403) so a non-owner
  // can't enumerate which contract ids exist in another tenant.
  if (!canManageContractsInOrg(user, contract.organization_id)) {
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
      // W1.S1a — the sender is the staff member, else the contract
      // location's configured brand; never a fixed gym's name.
      body: contractPushBody({
        sender: await contractPushSender(db, user.full_name, contract.location_id),
        templateName: contract.template?.name,
        kind: 'reminder',
      }),
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

  // The provider's own text stays in the log; the banner gets a fixed line.
  if (!emailResult.ok) logError('contracts', 'resend email failed', { contractId: contract.id, err: emailResult.error })
  return NextResponse.json({
    success: true,
    warning: emailResult.ok ? undefined : `Email could not be sent: ${emailProblem(emailResult.error)}`,
  })
})
