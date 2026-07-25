// /api/contracts/[id]/send
//
// CONTRACTS-DRAFT.1 — flip a draft contract to issued and fire the
// recipient's very first notification (email + push). A draft never
// emailed or pushed anyone at creation time, so this is where that
// first contact actually happens — unlike /resend (which re-fires a
// notification that already went out once).
//
// Guard mirrors /api/contracts/[id]/resend exactly:
//   - caller is master or owner
//   - org-scoped (404 not 403 for a foreign-org id — non-enumerable)
//   - status must be 'draft' (409 otherwise) — canTransition(status,
//     'issued') only allows draft -> issued, so it doubles as the
//     "only a draft can be sent" gate.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getOwnerOrganizationIds } from '@/lib/auth'
import { canTransition } from '@/lib/contracts'
import { notifyContractIssued } from '@/lib/contracts-notify'
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
      id, status, organization_id, location_id, profile_id, template_id,
      profile:profiles!profile_id (full_name, email)
    `)
    .eq('id', params.id)
    .maybeSingle()
  if (cErr) return NextResponse.json({ success: false, error: cErr.message }, { status: 500 })
  if (!contract) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  // Service-role read bypasses RLS — an owner must only be able to
  // send contracts in an org they own. 404 (not 403) so a non-owner
  // can't enumerate which contract ids exist in another tenant.
  if (!user.isMaster && !getOwnerOrganizationIds(user).includes(contract.organization_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (!canTransition(contract.status, 'issued')) {
    return NextResponse.json({
      success: false,
      error: `Cannot send a contract in status '${contract.status}'. Only drafts can be sent.`,
    }, { status: 409 })
  }

  // issued_at gets a fresh timestamp here — the draft row already
  // carries one from insert time (the contracts.issued_at column is
  // NOT NULL, so it default-fills at creation regardless of status),
  // which would otherwise misreport when the contract was actually
  // sent.
  const { data: updated, error: updErr } = await db
    .from('contracts')
    .update({
      status: 'issued',
      issued_at: new Date().toISOString(),
    })
    .eq('id', contract.id)
    .eq('status', 'draft') // optimistic-concurrency guard
    .select()
    .single()
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  if (!updated) {
    return NextResponse.json({ success: false, error: 'Contract status changed concurrently — refresh and retry.' }, { status: 409 })
  }

  // Look up template name for the audit details (notifyContractIssued
  // does its own lookup for the email/push copy).
  const { data: tplRow } = await db
    .from('contract_templates')
    .select('name')
    .eq('id', contract.template_id)
    .maybeSingle()

  // AUDIT-EXPAND.1 — record the send. Same action as a fresh issue
  // (contract.issued) since from the recipient's perspective this IS
  // the first issue; details.sent_from_draft distinguishes it in the
  // log for anyone auditing the draft workflow specifically.
  await logAuditEvent({
    category: 'business',
    action: 'contract.issued',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: {
      id: contract.profile_id,
      label: contract.profile?.full_name || null,
      resource: `contracts/${updated.id}`,
    },
    locationId: updated.location_id || null,
    details: {
      template_name: tplRow?.name || null,
      sent_from_draft: true,
    },
    request,
  })

  const { emailResult } = await notifyContractIssued({
    db,
    contract: { ...updated, profile: contract.profile },
    issuer: { full_name: user.full_name },
  })

  return NextResponse.json({
    success: true,
    data: updated,
    warning: emailResult.ok ? undefined : `Contract sent but email could not be sent: ${emailResult.error}`,
  })
}
