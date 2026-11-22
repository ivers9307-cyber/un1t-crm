// INVOICEPREP.3 — bring a set-aside row back.
//
// Preparation sets a row aside as not_invoice when it finds nothing to read
// (or a person marks it so). This route moves it back to received, clears
// what preparation left on it, and queues it to be read again. The read runs
// with the duplicate-by-file check on, as for any new arrival.
//
// The claim is cleared here: queueInvoicePreparation never clears one, and a
// leftover claim would keep the queue off the row.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadInvoiceForCaller, ROW_SELECT } from '../../_helpers'
import { queueInvoicePreparation } from '@/lib/invoices-queue/queue-preparation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in; loadInvoiceForCaller keeps the
// hand-written gate (row read, invoices_inbox and master-or-owner at the
// invoice's studio, every refusal a 404) exactly as the sibling routes run it.
export const POST = withAuth({ permission: null, location: false }, async ({ user: caller, params }) => {
  const id = params?.id
  const ctx = await loadInvoiceForCaller(caller, id)
  if (ctx.response) return ctx.response
  const { db, row } = ctx

  if (row.status !== 'not_invoice') {
    return NextResponse.json({
      success: false,
      error: `Cannot restore from '${row.status}' state.`,
    }, { status: 409 })
  }
  if (!row.attachment_path) {
    return NextResponse.json({ success: false, error: 'This row has no attachment to read.' }, { status: 400 })
  }

  const { data: restored, error } = await db
    .from('invoices_queue')
    .update({
      status: 'received',
      not_invoice_reason: null,
      review_reasons: [],
      prepared_at: null,
      duplicate_of_id: null,
      extraction_error: null,
      analysis_claimed_at: null,
    })
    .eq('id', id)
    .eq('status', 'not_invoice')
    .select('id')
  if (error) {
    logError('invoices-inbox', 'restore failed', { invoiceId: id, err: error })
    return NextResponse.json({ success: false, error: 'Could not restore the invoice. Try again.' }, { status: 500 })
  }
  if (!restored || restored.length === 0) {
    return NextResponse.json({ success: false, error: 'Row was modified concurrently — refresh and retry.' }, { status: 409 })
  }

  // The restore stands even if queueing fails: the row is back in received
  // and a person can still read it with "Read again".
  try {
    await queueInvoicePreparation(db, [id])
  } catch (err) {
    logError('invoices-inbox', 'restore: could not queue preparation', { invoiceId: id, err })
  }

  const { data, error: readErr } = await db
    .from('invoices_queue')
    .select(ROW_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (readErr) logError('invoices-inbox', 'restore: reload failed', { invoiceId: id, err: readErr })
  return NextResponse.json({ success: true, data: readErr ? null : data })
})
