// /api/contracts/[id]/decline
//
// Recipient declines their own contract with a reason.
//
// Allowed only when:
//   - caller is the contract's recipient (profile_id match)
//   - status is 'issued' or 'viewed'
//
// Terminal: declined contracts cannot be undone. The issuer can
// re-issue with a new contract row if the situation changes.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { contractDeclineSchema } from '@/lib/schemas'
import { canTransition } from '@/lib/contracts'
import { sendContractDeclinedEmail } from '@/lib/contracts-email'
import { logAuditEvent } from '@/lib/audit'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'

// withAuth only signs the caller in (the same 401). The body, the contract
// (404), the recipient check (403) and the state (409) keep their order; the
// write, the audit row and the issuer email are unchanged.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {

  const validation = await validateBody(request, contractDeclineSchema)
  if (!validation.ok) return validation.response
  const parsed = { data: validation.data }

  const { data: contract, error: rErr } = await db
    .from('contracts')
    .select('id, profile_id, status')
    .eq('id', params.id)
    .maybeSingle()
  if (rErr) {
    logError('contracts-decline', 'contract read failed', { contractId: params.id, err: rErr })
    return NextResponse.json({ success: false, error: 'Could not read the contract. Try again.' }, { status: 500 })
  }
  if (!contract) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (contract.profile_id !== user.id) {
    return NextResponse.json({ success: false, error: 'Only the recipient can decline this contract.' }, { status: 403 })
  }
  if (!canTransition(contract.status, 'declined')) {
    return NextResponse.json({
      success: false,
      error: `Cannot decline a contract in status '${contract.status}'.`,
    }, { status: 409 })
  }

  const { data: updated, error: updErr } = await db
    .from('contracts')
    .update({
      status: 'declined',
      declined_at: new Date().toISOString(),
      declined_reason: parsed.data.declined_reason,
    })
    .eq('id', contract.id)
    .in('status', ['issued', 'viewed'])
    .select()
    .single()
  if (updErr) {
    logError('contracts-decline', 'decline update failed', { contractId: contract.id, err: updErr })
    return NextResponse.json({ success: false, error: 'Could not decline the contract. Refresh and try again.' }, { status: 500 })
  }
  if (!updated) {
    return NextResponse.json({ success: false, error: 'Contract status changed concurrently — refresh and retry.' }, { status: 409 })
  }

  // Notify issuer — best effort.
  const { data: detail } = await db
    .from('contracts')
    .select(`
      id,
      profile:profiles!profile_id (full_name, email),
      issuer:profiles!issued_by (full_name, email),
      template:contract_templates!template_id (name)
    `)
    .eq('id', updated.id)
    .maybeSingle()

  // AUDIT-EXPAND.1 — record the decline. The recipient is the
  // actor here (they declined). details includes the reason so an
  // admin reviewing the audit log can see WHY without opening the
  // contract page.
  await logAuditEvent({
    category: 'business',
    action: 'contract.declined',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: {
      id: user.id,
      label: detail?.profile?.full_name || user.full_name,
      resource: `contracts/${updated.id}`,
    },
    locationId: updated.location_id || null,
    details: {
      template_name: detail?.template?.name || null,
      declined_reason: parsed.data.declined_reason,
    },
    request,
  })

  const emailResult = await sendContractDeclinedEmail({
    contract: updated,
    recipient: detail?.profile,
    issuer: detail?.issuer,
    templateName: detail?.template?.name,
  })

  if (!emailResult.ok) logError('contracts-decline', 'issuer email failed', { contractId: updated.id, err: emailResult.error })
  return NextResponse.json({
    success: true,
    data: updated,
    warning: emailResult.ok ? undefined : 'Decline recorded but the issuer email failed.',
  })
})
