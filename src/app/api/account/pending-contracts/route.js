// /api/account/pending-contracts
//
// Lightweight read for the global "you have unsigned contracts"
// alert that fires on every authenticated page. Returns the count
// + minimal metadata for the modal/banner — no body_rendered; variables_data
// is read only for the frozen issuer label (W1.S2).
//
// Auth: any signed-in user. RLS on contracts (mig 106) already
// scopes recipient-self reads, so the SELECT only ever returns
// the caller's own pending contracts.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { contractCountersignatureLabel } from '@/lib/contracting-entity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data, error } = await db
    .from('contracts')
    .select(`
      id, status, issued_at, variables_data,
      template:contract_templates!template_id (name)
    `)
    .eq('profile_id', user.id)
    .in('status', ['issued', 'viewed'])
    .order('issued_at', { ascending: false })

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: (data || []).map(c => ({
      id: c.id,
      status: c.status,
      issued_at: c.issued_at,
      template_name: c.template?.name || 'Contract',
      // W1.S2 — the contracting entity frozen on the document at issue
      // (LEGALENT.1), so the alert names the issuer, never a literal brand.
      issuer: contractCountersignatureLabel(c),
    })),
  })
}
