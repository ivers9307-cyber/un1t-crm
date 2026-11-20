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
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

// withAuth only signs the caller in (the same 401); the row (404), the owner
// check (404), the status (409) and the guarded write keep their order here.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const { data: inv, error: loadErr } = await db
    .from('contractor_invoices')
    .select('id, contractor_id, status')
    .eq('id', params.id)
    .single()
  if (loadErr || !inv) {
    return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 })
  }

  // Only the contractor who submitted it can revoke. 404 (not 403) so a
  // non-owner can't tell this invoice exists.
  if (inv.contractor_id !== user.id) {
    return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 })
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
    logError('contractor-invoices', 'revoke failed', { invoiceId: params.id, err: updErr })
    return NextResponse.json({ success: false, error: 'Could not revoke the invoice. Refresh and try again.' }, { status: 400 })
  }
  if (!revoked) {
    return NextResponse.json(
      { success: false, error: 'Invoice was actioned by an approver before revoke could complete.' },
      { status: 409 }
    )
  }

  return NextResponse.json({ success: true, data: revoked })
})
