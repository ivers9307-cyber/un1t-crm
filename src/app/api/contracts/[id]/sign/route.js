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
// and flips status to 'signed', then (CONTRACTS-PDF.1) renders the
// dual-signed PDF, stores it at contracts/<id>/signed.pdf, records
// the path on the row, and attaches it to both confirmation emails.

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { contractSignSchema } from '@/lib/schemas'
import { canTransition } from '@/lib/contracts'
import { sendContractSignedEmails } from '@/lib/contracts-email'
import { renderContractPdf } from '@/lib/contract-pdf'
import { getLocationBranding } from '@/lib/location-branding'
import { contractCountersignatureLabel } from '@/lib/contracting-entity'
import { logAuditEvent } from '@/lib/audit'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // CONTRACTS-SIGN.1 — a legal e-signature must be the recipient's OWN act.
  // Refuse while the session is impersonating someone (a master "View as"
  // or a support session — both set impersonatingFrom), even though the
  // effective recipient id would match. The real user signs on their own
  // login. Belt-and-braces: support sessions are read-only anyway.
  if (user.impersonatingFrom || user.supportSession) {
    return NextResponse.json({ success: false, error: 'You cannot sign a contract while viewing as another user. The recipient must sign in themselves.' }, { status: 403 })
  }

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

  const warnings = []

  // CONTRACTS-PDF.1 — dual-signed PDF artifact.
  //
  // THE DB ROW IS STILL THE LEGAL RECORD. body_rendered + the
  // signature metadata + ip/ua/timestamp are what make this a valid
  // simple electronic signature under eIDAS Art. 25; the PDF is a
  // convenience artifact rendered FROM that record (and both detail
  // pages still render the same content as print-friendly HTML).
  // So the whole step is wrapped: a renderer bug, a Storage outage,
  // or a failed path write degrades to a warning on an otherwise
  // successful sign. Failing the sign here would be strictly worse
  // than having no PDF, because the recipient would be told their
  // signature did not go through when in fact the row is committed.
  //
  // Note the buffer deliberately survives a STORAGE failure: if the
  // render succeeded we can still attach the PDF to the confirmation
  // emails even though it is not downloadable from /pdf yet.
  let pdfBuffer = null
  try {
    const branding = await getLocationBranding(db, updated.location_id)
    pdfBuffer = await renderContractPdf({
      bodyRendered: updated.body_rendered,
      issuerSignature: updated.issuer_signature,
      issuedAt: updated.issued_at,
      recipientSignature: updated.signature_value,
      signedAt: updated.signed_at,
      signedIp: updated.signed_ip,
      templateName: detail?.template?.name,
      companyName: branding?.companyName,
      // LEGALENT.1 — the countersignature label is a legal-entity
      // claim, not the brand wordmark, and this buffer is both stored
      // in the private `contracts` bucket and attached to the
      // confirmation emails below, so it is the archived copy. Read
      // the contract's OWN frozen entity — the same string the two web
      // pages and the mobile screen render — so the document and its
      // PDF can never name two different counterparties. `updated`
      // comes from the UPDATE's `.select()`, so variables_data is on it.
      contractingEntity: contractCountersignatureLabel(updated),
    })
    const pdfPath = `${updated.id}/signed.pdf`
    const { error: upErr } = await db.storage
      .from('contracts')
      .upload(pdfPath, pdfBuffer, { contentType: 'application/pdf', upsert: true })
    if (upErr) throw new Error(upErr.message)
    // Must be awaited — a bare .update() thenable never fires.
    const { error: pathErr } = await db
      .from('contracts')
      .update({ signed_pdf_path: pdfPath })
      .eq('id', updated.id)
    if (pathErr) throw new Error(pathErr.message)
    updated.signed_pdf_path = pdfPath
  } catch (e) {
    warnings.push(`Signed PDF could not be generated or stored: ${e?.message || 'unknown error'}`)
  }

  const emailResults = await sendContractSignedEmails({
    contract: updated,
    recipient: detail?.profile,
    issuer: detail?.issuer,
    templateName: detail?.template?.name,
    pdfBuffer,
  })

  if (emailResults.warning) warnings.push(emailResults.warning)
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
