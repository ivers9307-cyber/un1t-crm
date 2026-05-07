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

export const runtime = 'nodejs'

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const raw = await request.json().catch(() => ({}))
  const parsed = contractSignSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

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

  const h = headers()
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

  // TODO (commit 3): trigger PDF generation, upload to Storage at
  // contracts/<id>/signed.pdf, persist signed_pdf_path on the row,
  // and fire two Postmark emails:
  //   - To the recipient: "Your contract has been signed" with
  //     PDF attached.
  //   - To the issuer: "Sarah signed her contract" with PDF
  //     attached + a link to the contract detail page.
  // Until that lands, signed contracts have body_rendered + the
  // signature metadata in the row, which is sufficient as a legal
  // record on its own. The PDF is a derivative.

  return NextResponse.json({ success: true, data: updated })
}
