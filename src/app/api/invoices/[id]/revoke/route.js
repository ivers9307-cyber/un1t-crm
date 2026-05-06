// POST /api/invoices/[id]/revoke
//
// Contractor self-revoke. Only the invoice's owner can revoke, and
// only while status='submitted'. After revoke they can submit a
// fresh row for the same period.
//
// We don't touch the PDF in storage (it stays linked to the
// revoked row for audit) and we don't email anyone — the approver
// just sees the new status next time they refresh.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

export const runtime = 'nodejs'

export async function POST(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const { data: inv, error: loadErr } = await db
    .from('contractor_invoices')
    .select('id, contractor_id, status')
    .eq('id', params.id)
    .single()
  if (loadErr || !inv) {
    return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 })
  }

  // Only the contractor who submitted it can revoke.
  if (inv.contractor_id !== user.id) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  if (inv.status !== 'submitted') {
    return NextResponse.json(
      {
        success: false,
        error:
          inv.status === 'approved'
            ? 'This invoice has already been approved and cannot be revoked.'
            : `This invoice is in '${inv.status}' state and cannot be revoked.`,
      },
      { status: 409 }
    )
  }

  const now = new Date().toISOString()
  const { data: revoked, error: updErr } = await db
    .from('contractor_invoices')
    .update({ status: 'revoked', revoked_at: now })
    .eq('id', params.id)
    .eq('status', 'submitted') // race-safe vs simultaneous approval
    .select()
    .single()
  if (updErr) {
    return NextResponse.json({ success: false, error: updErr.message }, { status: 400 })
  }
  if (!revoked) {
    return NextResponse.json(
      { success: false, error: 'Invoice was actioned by an approver before revoke could complete.' },
      { status: 409 }
    )
  }

  return NextResponse.json({ success: true, data: revoked })
}
