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

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getOwnerOrganizationIds } from '@/lib/auth'
import { canTransition } from '@/lib/contracts'
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
    .select('id, status, organization_id, location_id, profile_id')
    .eq('id', params.id)
    .maybeSingle()
  if (cErr) return NextResponse.json({ success: false, error: cErr.message }, { status: 500 })
  if (!contract) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  // Service-role read bypasses RLS — an owner must only be able to
  // discard drafts in an org they own. 404 (not 403) so a non-owner
  // can't enumerate which contract ids exist in another tenant.
  if (!user.isMaster && !getOwnerOrganizationIds(user).includes(contract.organization_id)) {
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
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
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
}
