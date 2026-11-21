// /api/contracts/[id]/discard
//
// CONTRACTS-DRAFT.1 — silently kill a draft that was never sent. The
// recipient never knew it existed, so unlike /revoke this never
// emails them. Draft-only: a contract that's already been issued
// must go through /revoke instead, which DOES notify the recipient
// (they need to know a real contract was withdrawn).
//
// Guard mirrors /api/contracts/[id]/resend and /revoke:
//   - caller is master or owner
//   - org-scoped (404 not 403 for a foreign-org id — non-enumerable)
//   - status must be 'draft' (409 otherwise)
//
// withAuth only signs the caller in (the same 401); every check after it
// keeps its order and text, and the write is unchanged.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { canManageContractsInOrg, canManageContractsSomewhere } from '@/lib/contract-gates'
import { canTransition } from '@/lib/contracts'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'


export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {  // GATES-2 — coarse only (master, or owner/admin of SOME org). It asked
  // user.role, the ACTIVE studio's role, which refused an owner of the
  // contract's org working from another studio. The decision is below.
  if (!canManageContractsSomewhere(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  const { data: contract, error: cErr } = await db
    .from('contracts')
    .select('id, status, organization_id, location_id, profile_id')
    .eq('id', params.id)
    .maybeSingle()
  if (cErr) {
    logError('contracts', 'discard: contract read failed', { contractId: params.id, err: cErr })
    return NextResponse.json({ success: false, error: 'Could not load the contract. Try again.' }, { status: 500 })
  }
  if (!contract) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  // Service-role read bypasses RLS — an owner must only be able to
  // discard drafts in an org they own. 404 (not 403) so a non-owner
  // can't enumerate which contract ids exist in another tenant.
  if (!canManageContractsInOrg(user, contract.organization_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  // Draft only. canTransition(status, 'revoked') alone isn't a tight
  // enough gate here — issued/viewed are ALSO legal ->revoked
  // transitions, and those must keep going through /revoke (which
  // emails the recipient). The explicit status check keeps this
  // route's blast radius to drafts only.
  if (contract.status !== 'draft' || !canTransition(contract.status, 'revoked')) {
    return NextResponse.json({
      success: false,
      error: `Cannot discard a contract in status '${contract.status}'. Only drafts can be discarded.`,
    }, { status: 409 })
  }

  const { data: updated, error: updErr } = await db
    .from('contracts')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revoked_by: user.id,
      revoked_reason: 'Draft discarded',
    })
    .eq('id', contract.id)
    .eq('status', 'draft') // optimistic-concurrency guard
    .select()
    .single()
  if (updErr) {
    logError('contracts', 'discard: write failed', { contractId: contract.id, err: updErr })
    return NextResponse.json({ success: false, error: 'Could not discard the draft. Refresh and try again.' }, { status: 500 })
  }
  if (!updated) {
    return NextResponse.json({ success: false, error: 'Contract status changed concurrently — refresh and retry.' }, { status: 409 })
  }

  // AUDIT-EXPAND.1 — record the discard. No email is sent (see
  // header comment), so this audit row is the only trace that the
  // draft ever existed.
  await logAuditEvent({
    category: 'business',
    action: 'contract.discarded',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: {
      id: contract.profile_id,
      label: null,
      resource: `contracts/${updated.id}`,
    },
    locationId: updated.location_id || null,
    details: {},
    request,
  })

  return NextResponse.json({ success: true, data: updated })
})
