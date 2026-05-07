// /api/contracts/[id]
//   GET  fetch one contract.
//        - Recipient sees their own (RLS).
//        - Master sees all (RLS).
//        - Owner sees their org (RLS).
//        Side effect: when the recipient is the caller and the
//        contract is still 'issued', flip it to 'viewed' + stamp
//        viewed_at. This gives the issuer signal that the recipient
//        has at least opened the document.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { canTransition } from '@/lib/contracts'

export const runtime = 'nodejs'

export async function GET(_request, { params }) {
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
      profile:profiles!profile_id (full_name, email, role, employment_type),
      issuer:profiles!issued_by (full_name, email, role),
      template:contract_templates!template_id (name, version)
    `)
    .eq('id', params.id)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!contract) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // First-view tick — only when the recipient is the caller and
  // the contract is still in 'issued'. Quietly best-effort: if
  // the update fails (race condition, RLS edge case) we still
  // return the read.
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

  return NextResponse.json({ success: true, data: contract })
}
