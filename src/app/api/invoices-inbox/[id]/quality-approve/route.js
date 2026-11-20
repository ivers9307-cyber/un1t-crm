// INVOICES.1 stage 1 approve — operator confirms the attachment is
// legible. Moves received → quality_approved. From there the
// /extract route runs Claude Vision OCR.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadInvoiceForCaller } from '../../_helpers'
import { canTransitionInboundInvoice } from '@/lib/inbound-invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in; loadInvoiceForCaller keeps the
// hand-written gate (row read, invoices_inbox and master-or-owner at the
// invoice's studio, every refusal a 404) exactly as the sibling routes run it.
export const POST = withAuth({ permission: null, location: false }, async ({ user: caller, params }) => {
  const id = params?.id
  const ctx = await loadInvoiceForCaller(caller, id)
  if (ctx.response) return ctx.response
  const { user, db, row } = ctx

  if (!canTransitionInboundInvoice(row.status, 'quality_approved')) {
    return NextResponse.json({
      success: false,
      error: `Cannot approve quality from '${row.status}' state.`,
    }, { status: 409 })
  }
  if (!row.attachment_path) {
    return NextResponse.json({
      success: false,
      error: 'This row has no attachment to approve.',
    }, { status: 400 })
  }

  const { data: updated, error } = await db
    .from('invoices_queue')
    .update({
      status: 'quality_approved',
      quality_reviewed_at: new Date().toISOString(),
      quality_reviewed_by: user.id,
    })
    .eq('id', id)
    .eq('status', 'received') // optimistic concurrency
    .select('id, status, quality_reviewed_at, quality_reviewed_by')
    .single()
  if (error) {
    logError('invoices-inbox', 'quality approve failed', { invoiceId: id, err: error })
    return NextResponse.json({ success: false, error: 'Could not approve the invoice. Try again.' }, { status: 500 })
  }
  if (!updated) {
    return NextResponse.json({
      success: false,
      error: 'Row was modified concurrently — refresh and retry.',
    }, { status: 409 })
  }
  return NextResponse.json({ success: true, data: updated })
})
