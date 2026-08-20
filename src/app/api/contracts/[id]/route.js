// /api/contracts/[id]
//   GET  fetch one contract. Visibility (mig 106's model) is enforced
//        in the APP LAYER here — this route uses createServerClient()
//        (service role) which BYPASSES RLS, so the DB policies don't
//        filter it (C1, 2026-06 platform audit):
//        - Recipient sees their own.
//        - Master sees all.
//        - Owner sees their org.
//        - Anyone else → 404 (we don't confirm the row exists to a
//          caller with no right to see it).
//        Side effect: when the recipient is the caller and the
//        contract is still 'issued', flip it to 'viewed' + stamp
//        viewed_at. This gives the issuer signal that the recipient
//        has at least opened the document.
//
//        CONTRACTS-DRAFT.1 — this is also what the re-issue wizard
//        (?from=<id>) fetches to prefill recipient/template/custom
//        vars. The profile embed carries the compensation fields
//        (annual_salary etc.) too, not just identity — customVariablesFrom()
//        needs them to recognise which frozen variables_data keys are
//        profile-derived (and so should NOT be re-typed as "custom").
//        Access model is unchanged: same recipient/master/owner gate.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getOwnerOrganizationIds } from '@/lib/auth'
import { canTransition } from '@/lib/contracts'
import { getContractingEntity } from '@/lib/contracting-entity'

export const runtime = 'nodejs'

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: contract, error } = await db
    .from('contracts')
    .select(`
      id, template_id, profile_id, location_id, organization_id,
      variables_data, body_rendered, status,
      issued_at, issued_by, issuer_signature,
      viewed_at, signed_at, signed_ip, signature_method, signature_value,
      signed_pdf_path, declined_at, declined_reason,
      revoked_at, revoked_by, revoked_reason,
      profile:profiles!profile_id (
        full_name, email, role, employment_type,
        annual_salary, hourly_rate, overtime_rate, contracted_hours_per_week
      ),
      issuer:profiles!issued_by (full_name, email, role),
      template:contract_templates!template_id (name, version)
    `)
    .eq('id', params.id)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!contract) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // App-layer visibility gate (C1). Service-role read above bypassed
  // RLS, so enforce mig 106's model here: recipient, master, or an
  // owner of the contract's organization may read it. Everyone else
  // gets 404 — same response as a missing row, so an unauthorised
  // caller can't even confirm the contract exists by enumerating IDs.
  const isRecipient = contract.profile_id === user.id
  const isOrgOwner = getOwnerOrganizationIds(user).includes(contract.organization_id)
  if (!isRecipient && !user.isMaster && !isOrgOwner) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  // CONTRACTS-DRAFT.1 — a draft is issuer-side only. A caller who
  // clears the gate above SOLELY as the recipient (not also master
  // or an org owner) must get the same 404 a stranger would — the
  // recipient was never notified this row exists, and "the id is
  // hard to guess" is not a access-control boundary we rely on
  // (that's exactly the residual this hardens against). Master and
  // org-owner callers still resolve it — they need the row to send
  // or discard it, and the re-issue wizard's ?from=<id> prefill
  // fetches this route as one of them.
  if (contract.status === 'draft' && isRecipient && !user.isMaster && !isOrgOwner) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  // First-view tick — only when the recipient is the caller and
  // the contract is still in 'issued'. Quietly best-effort: if
  // the update fails (race condition, RLS edge case) we still
  // return the read. Can never fire for a draft: the explicit
  // `contract.status === 'issued'` check already excludes it, and a
  // recipient-only caller never even reaches this line for a draft —
  // the gate above 404s first.
  if (
    contract.profile_id === user.id
    && canTransition(contract.status, 'viewed')
    && contract.status === 'issued'
  ) {
    await db
      .from('contracts')
      .update({ status: 'viewed', viewed_at: new Date().toISOString() })
      .eq('id', contract.id)
      .eq('status', 'issued') // optimistic-concurrency guard
    contract.status = 'viewed'
    contract.viewed_at = new Date().toISOString()
  }

  // LEGALENT.1 — the mobile signing screen renders the same
  // countersignature block as the web pages, and it cannot import
  // src/lib (the shared/ seam is the only route, and this needs a
  // service-role read anyway), so the resolved contracting entity
  // rides along on the payload. Read-only, additive: an older client
  // that ignores the field behaves exactly as before.
  const { label: contractingEntity } = await getContractingEntity(db, {
    organizationId: contract.organization_id,
    locationId: contract.location_id,
  })

  return NextResponse.json({
    success: true,
    data: { ...contract, contracting_entity: contractingEntity },
  })
}
