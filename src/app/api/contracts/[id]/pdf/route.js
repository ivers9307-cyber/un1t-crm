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

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getOwnerOrganizationIds } from '@/lib/auth'

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
  const isOrgOwner = getOwnerOrganizationIds(user).includes(contract.organization_id)
  if (!isRecipient && !user.isMaster && !isOrgOwner) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (contract.status === 'draft' && isRecipient && !user.isMaster && !isOrgOwner) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  // No PDF yet (unsigned, or the sign-time generation degraded to a
  // warning). Same 404 shape — there is nothing to download.
  if (!contract.signed_pdf_path) {
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
