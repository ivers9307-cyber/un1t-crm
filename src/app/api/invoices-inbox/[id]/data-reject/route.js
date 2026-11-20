// INVOICES.1 stage 2 reject — operator looks at the extracted
// fields and decides the invoice can't be forwarded (e.g. OCR
// extracted total doesn't match a re-check of the attachment, the
// supplier turned out to be a duplicate already booked in Xero, the
// "invoice" is actually a quote). Terminal.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/validate'
import { loadInvoiceForUser } from '../../_helpers'
import { canTransitionInboundInvoice } from '@/lib/inbound-invoices'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({
  reason: z.string().min(1).max(1000),
})

// Sign-in here, then loadInvoiceForUser (which signs the caller in again) keeps
// its 404s for another studio's row and its owner/master + invoices_inbox
// rule; every later check is unchanged.
export const POST = withAuth({ permission: null, location: false }, async ({ request, params }) => {
  const id = params?.id
  const ctx = await loadInvoiceForUser(id)
  if (ctx.response) return ctx.response
  const { user, db, row } = ctx

  // Legal from any post-OCR pre-forward state.
  if (row.status !== 'extracted' && row.status !== 'data_approved') {
    return NextResponse.json({
      success: false,
      error: `Data reject only applies in 'extracted' or 'data_approved' state. This one is '${row.status}'.`,
    }, { status: 409 })
  }
  if (!canTransitionInboundInvoice(row.status, 'rejected')) {
    return NextResponse.json({ success: false, error: 'Illegal transition.' }, { status: 409 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { reason } = validation.data

  const { data: updated, error } = await db
    .from('invoices_queue')
    .update({
      status: 'rejected',
      rejected_stage: 'data',
      rejected_at: new Date().toISOString(),
      reject_reason: reason,
      data_reviewed_at: new Date().toISOString(),
      data_reviewed_by: user.id,
    })
    .eq('id', id)
    .in('status', ['extracted', 'data_approved'])
    .select('id, status, rejected_stage, rejected_at, reject_reason')
    .single()
  if (error) {
    logError('invoices-inbox', 'data reject failed', { invoiceId: id, err: error })
    return NextResponse.json({ success: false, error: 'Could not reject the invoice. Try again.' }, { status: 500 })
  }
  if (!updated) {
    return NextResponse.json({
      success: false,
      error: 'Row was modified concurrently — refresh and retry.',
    }, { status: 409 })
  }
  return NextResponse.json({ success: true, data: updated })
})
