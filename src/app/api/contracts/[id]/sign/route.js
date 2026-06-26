// /api/contracts/[id]/sign
//
// Recipient signs their own contract with a typed name.
//
// Allowed only when:
//   - caller is the contract's recipient (profile_id match)
//   - status is 'issued' or 'viewed' (terminal statuses cannot be
//     re-signed)
//
// The route stamps signed_at + IP + UA + signature_method/value
// and flips status to 'signed'. PDF generation + email are
// triggered after this returns successfully (commit 3 work — the
// stub below logs and falls through so the sign still completes
// before the PDF pipeline lands).

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { contractSignSchema } from '@/lib/schemas'
import { canTransition } from '@/lib/contracts'
import { sendContractSignedEmails } from '@/lib/contracts-email'
import { logAuditEvent } from '@/lib/audit'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, contractSignSchema)
  if (!validation.ok) return validation.response
  const parsed = { data: validation.data }

  const db = createServerClient()
  // Pre-read so we can validate ownership + the current status
  // before issuing the UPDATE. We could rely on the RLS update
  // policy but the failure mode would be a generic "no rows
  // updated" — a pre-read gives us specific 403 / 409 responses.
  const { data: contract, error: rErr } = await db
    .from('contracts')
    .select('id, profile_id, status')
    .eq('id', params.id)
    .maybeSingle()
  if (rErr) return NextResponse.json({ success: false, error: rErr.message }, { status: 500 })
  if (!contract) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (contract.profile_id !== user.id) {
    return NextResponse.json({ success: false, error: 'Only the recipient can sign this contract.' }, { status: 403 })
  }
  if (!canTransition(contract.status, 'signed')) {
    return NextResponse.json({
      success: false,
      error: `Cannot sign a contract in status '${contract.status}'.`,
    }, { status: 409 })
  }

  const h = await headers()
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || null
  const userAgent = h.get('user-agent') || null
  const now = new Date().toISOString()

  const { data: updated, error: updErr } = await db
    .from('contracts')
    .update({
      status: 'signed',
      signed_at: now,
      signed_ip: ip,
      signed_user_agent: userAgent,
      signature_method: parsed.data.signature_method,
      signature_value: parsed.data.signature_value,
    })
    .eq('id', contract.id)
    .in('status', ['issued', 'viewed']) // optimistic concurrency guard
    .select()
    .single()
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  if (!updated) {
    return NextResponse.json({ success: false, error: 'Contract status changed concurrently — refresh and retry.' }, { status: 409 })
  }

  // Look up recipient + issuer + template name for the
  // confirmation emails. Best-effort — the contract is already
  // signed; an email failure is a warning not a rollback.
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

  // AUDIT-EXPAND.1 — record the contract signing. The actor here
  // is the recipient (they signed it). target_resource links back
  // to the contract row in /admin/contracts/<id>.
  await logAuditEvent({
    category: 'business',
    action: 'contract.signed',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: {
      id: user.id,
      label: detail?.profile?.full_name || user.full_name,
      resource: `contracts/${updated.id}`,
    },
    locationId: updated.location_id || null,
    details: {
      template_name: detail?.template?.name || null,
      signature_method: parsed.data.signature_method,
    },
    request,
  })

  const emailResults = await sendContractSignedEmails({
    contract: updated,
    recipient: detail?.profile,
    issuer: detail?.issuer,
    templateName: detail?.template?.name,
  })

  // PDF generation is deliberately deferred — body_rendered +
  // signature metadata + ip/ua/timestamp are the actual legal
  // record. Both /admin/contracts/[id] and /account/contracts/[id]
  // render that to print-friendly HTML so either party can
  // browser-save-as-PDF whenever they need a tangible copy.

  const warnings = []
  if (emailResults.recipient && !emailResults.recipient.ok) {
    warnings.push(`Recipient email failed: ${emailResults.recipient.error}`)
  }
  if (emailResults.issuer && !emailResults.issuer.ok) {
    warnings.push(`Issuer email failed: ${emailResults.issuer.error}`)
  }

  return NextResponse.json({
    success: true,
    data: updated,
    warning: warnings.length ? warnings.join('; ') : undefined,
  })
}
