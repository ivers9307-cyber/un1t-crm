// /api/contracts/[id]/pdf
//   GET  download the dual-signed PDF stored at contracts/<id>/signed.pdf
//        (written by the sign route, CONTRACTS-PDF.1).
//
//        Authorization mirrors GET /api/contracts/[id] EXACTLY — same
//        model, same 404-not-403 posture. This route also runs as
//        service role (createServerClient bypasses RLS), so the bucket's
//        own read policies do NOT filter it; the gate below is the only
//        thing standing between a guessed id and someone's employment
//        contract:
//        - Recipient sees their own.
//        - Master sees all.
//        - Owner sees their org.
//        - Anyone else -> 404 (existence is never confirmed).
//        A draft is 404 for a recipient-only caller, same as the detail
//        route. A draft can never have a PDF anyway (only the sign route
//        writes signed_pdf_path), but the model is kept identical so the
//        two routes cannot drift apart.
//
//        The bucket is PRIVATE and stays private. We mint a 60-second
//        signed URL per request and 302 to it, so the link in the
//        browser's history dies almost immediately and the object is
//        never publicly addressable.
//
//        CONTRACTS-PDF.2 — a SIGNED contract with no stored PDF (signed
//        before CONTRACTS-PDF.1, or the sign-time generation degraded to
//        a warning) answers a JSON 409 `code: 'pdf_missing'` saying the
//        PDF can be generated, instead of the bare 'Not found' that four
//        of the five signed contracts in prod answered with. An unsigned
//        contract with no PDF stays 404: there is nothing to generate.
//
//   POST render and store the PDF for an already-signed contract whose
//        signed_pdf_path is NULL, exactly as the sign route does (the two
//        share renderAndStoreSignedContractPdf). Master or an organisation
//        admin of the contract's org; everyone else, and a foreign id, is
//        404 (same posture as the GET). 409 when the contract is not
//        signed. Idempotent: a contract that already has a path is a 200
//        no-op (`generated: false`), so a double click or a re-run of the
//        backfill never re-renders an archived copy.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { canManageContractsInOrg, CONTRACT_PDF_MISSING_MESSAGE } from '@/lib/contract-gates'
import { renderAndStoreSignedContractPdf } from '@/lib/contract-pdf-store'
import { displayZoneFor } from '@/lib/display-zone'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: contract, error } = await db
    .from('contracts')
    .select('id, profile_id, organization_id, status, signed_pdf_path')
    .eq('id', params.id)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!contract) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const isRecipient = contract.profile_id === user.id
  // C18 ORGROLE.1 — the org side is an organisation admin of the contract's
  // org (master or an org_admin grant), no longer any studio owner there.
  const isOrgOwner = canManageContractsInOrg(user, contract.organization_id)
  if (!isRecipient && !user.isMaster && !isOrgOwner) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (contract.status === 'draft' && isRecipient && !user.isMaster && !isOrgOwner) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  if (!contract.signed_pdf_path) {
    // CONTRACTS-PDF.2 — signed, so the record can be rendered: say so.
    if (contract.status === 'signed') {
      return NextResponse.json({
        success: false,
        error: CONTRACT_PDF_MISSING_MESSAGE,
        code: 'pdf_missing',
        canGenerate: Boolean(user.isMaster || isOrgOwner),
      }, { status: 409 })
    }
    // Unsigned: nothing to download and nothing to generate. Same 404 shape.
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const { data: signed, error: signErr } = await db.storage
    .from('contracts')
    .createSignedUrl(contract.signed_pdf_path, 60)
  if (signErr || !signed?.signedUrl) {
    return NextResponse.json({
      success: false,
      error: signErr?.message || 'Could not prepare the download link.',
    }, { status: 500 })
  }

  return NextResponse.redirect(signed.signedUrl, 302)
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: contract, error } = await db
    .from('contracts')
    .select(`
      id, profile_id, organization_id, location_id, status, signed_pdf_path,
      body_rendered, issuer_signature, issued_at, signature_value, signed_at, signed_ip,
      variables_data,
      profile:profiles!profile_id (full_name),
      template:contract_templates!template_id (name)
    `)
    .eq('id', params.id)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!contract) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // Service-role read bypasses RLS: judge at the CONTRACT's org. 404, not
  // 403, so a caller outside the org (the recipient included) learns nothing
  // about which ids exist — the GET's posture.
  if (!canManageContractsInOrg(user, contract.organization_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (contract.status !== 'signed') {
    return NextResponse.json({
      success: false,
      error: `Cannot generate a PDF for a contract in status '${contract.status}'. Only a signed contract has a signed record to render.`,
      code: 'not_signed',
    }, { status: 409 })
  }
  if (contract.signed_pdf_path) {
    return NextResponse.json({
      success: true,
      data: { id: contract.id, signed_pdf_path: contract.signed_pdf_path, generated: false },
    })
  }

  // TZ.8b — the PDF prints the signature times on the contract's studio clock.
  const zone = await displayZoneFor(db, user, contract.location_id, 'contracts')
  const pdf = await renderAndStoreSignedContractPdf({
    db,
    contract,
    templateName: contract.template?.name,
    zone,
  })
  if (pdf.error || !pdf.pdfPath) {
    return NextResponse.json({
      success: false,
      error: `Signed PDF could not be generated or stored: ${pdf.error || 'unknown error'}`,
    }, { status: 500 })
  }

  // Record who rebuilt the archived copy, and from which record. Best
  // effort: the PDF is stored whatever this write does.
  try {
    await logAuditEvent({
      category: 'business',
      action: 'contract.pdf_generated',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: {
        id: contract.profile_id,
        label: contract.profile?.full_name || null,
        resource: `contracts/${contract.id}`,
      },
      locationId: contract.location_id || null,
      details: {
        template_name: contract.template?.name || null,
        signed_at: contract.signed_at || null,
        signed_pdf_path: pdf.pdfPath,
      },
      request,
    })
  } catch {
    // Audit is non-blocking; intentionally swallow.
  }

  return NextResponse.json({
    success: true,
    data: { id: contract.id, signed_pdf_path: pdf.pdfPath, generated: true },
  })
}
