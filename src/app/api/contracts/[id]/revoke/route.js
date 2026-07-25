// /api/contracts/[id]/revoke
//
// Issuer (master/owner) revokes a contract that hasn't been signed
// yet. Useful when a typo / wrong template / wrong recipient is
// caught after issuing.
//
// Allowed only when:
//   - caller is master or owner
//   - status is 'issued' or 'viewed' (signed/declined/already-revoked
//     contracts are terminal and cannot be revoked)

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getOwnerOrganizationIds } from '@/lib/auth'
import { contractRevokeSchema } from '@/lib/schemas'
import { canTransition } from '@/lib/contracts'
import { sendContractRevokedEmail } from '@/lib/contracts-email'
import { logAuditEvent } from '@/lib/audit'
import { validateBody } from '@/lib/validate'

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

  const validation = await validateBody(request, contractRevokeSchema)
  if (!validation.ok) return validation.response
  const parsed = { data: validation.data }

  const db = createServerClient()
  const { data: contract, error: rErr } = await db
    .from('contracts')
    .select('id, status, organization_id')
    .eq('id', params.id)
    .maybeSingle()
  if (rErr) return NextResponse.json({ success: false, error: rErr.message }, { status: 500 })
  if (!contract) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  // Service-role read bypasses RLS — an owner must only be able to
  // revoke contracts in an org they own. 404 (not 403) so a non-owner
  // can't enumerate which contract ids exist in another tenant.
  if (!user.isMaster && !getOwnerOrganizationIds(user).includes(contract.organization_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  // CONTRACTS-DRAFT.1 — drafts are NOT revoked here even though
  // canTransition(draft, revoked) is technically legal in the pure
  // state machine (draft -> revoked is how the state machine models
  // "killed before ever being sent"). This route emails the
  // recipient (sendContractRevokedEmail below) — for a draft that's
  // wrong, since the recipient never knew it existed. Drafts go
  // through /api/contracts/[id]/discard instead, which is silent.
  if (contract.status === 'draft') {
    return NextResponse.json({
      success: false,
      error: 'Cannot revoke a draft contract — use the discard action instead.',
    }, { status: 409 })
  }
  if (!canTransition(contract.status, 'revoked')) {
    return NextResponse.json({
      success: false,
      error: `Cannot revoke a contract in status '${contract.status}'. Only unsigned contracts can be revoked.`,
    }, { status: 409 })
  }

  const { data: updated, error: updErr } = await db
    .from('contracts')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revoked_by: user.id,
      revoked_reason: parsed.data.revoked_reason,
    })
    .eq('id', contract.id)
    .in('status', ['issued', 'viewed'])
    .select()
    .single()
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  if (!updated) {
    return NextResponse.json({ success: false, error: 'Contract status changed concurrently — refresh and retry.' }, { status: 409 })
  }

  // Notify recipient — best effort.
  const { data: detail } = await db
    .from('contracts')
    .select(`
      id,
      profile:profiles!profile_id (full_name, email),
      template:contract_templates!template_id (name)
    `)
    .eq('id', updated.id)
    .maybeSingle()

  // AUDIT-EXPAND.1 — record the revoke. Actor is the issuer
  // (master/owner); target is the recipient (the person who'll no
  // longer be on the hook for signing it).
  await logAuditEvent({
    category: 'business',
    action: 'contract.revoked',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: {
      id: detail?.profile ? updated.profile_id : null,
      label: detail?.profile?.full_name || null,
      resource: `contracts/${updated.id}`,
    },
    locationId: updated.location_id || null,
    details: {
      template_name: detail?.template?.name || null,
      revoked_reason: parsed.data.revoked_reason,
    },
    request,
  })

  const emailResult = await sendContractRevokedEmail({
    contract: updated,
    recipient: detail?.profile,
    templateName: detail?.template?.name,
  })

  return NextResponse.json({
    success: true,
    data: updated,
    warning: emailResult.ok ? undefined : `Revoke recorded but recipient email failed: ${emailResult.error}`,
  })
}
