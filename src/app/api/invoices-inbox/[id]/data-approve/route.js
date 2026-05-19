// INVOICES.1 stage 2 approve — operator confirms the extracted
// fields are correct. Moves extracted → data_approved → forwarded
// (the latter happens synchronously inside this route after the
// Xero forward email lands).
//
// On Xero forward success → status='forwarded'.
// On Xero forward failure → row stays in data_approved with
// xero_error populated so the inbox shows a retry button.

import { NextResponse } from 'next/server'
import { loadInvoiceForUser } from '../../_helpers'
import { canTransitionInboundInvoice } from '@/lib/inbound-invoices'
import { sendInboundInvoiceBillEmail } from '@/lib/xero/inbound-invoice-forward'
import { XeroError } from '@/lib/xero/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, { params }) {
  const { id } = await params
  const ctx = await loadInvoiceForUser(id)
  if (ctx.response) return ctx.response
  const { user, db, row } = ctx

  // Legal: extracted → data_approved (first run) OR data_approved
  // → forwarded (retry path). Either lands us in the same end state.
  if (row.status !== 'extracted' && row.status !== 'data_approved') {
    return NextResponse.json({
      success: false,
      error: `Cannot data-approve from '${row.status}' state.`,
    }, { status: 409 })
  }
  if (row.status === 'extracted' && !canTransitionInboundInvoice(row.status, 'data_approved')) {
    return NextResponse.json({ success: false, error: 'Illegal transition.' }, { status: 409 })
  }
  if (!row.extracted_fields) {
    return NextResponse.json({
      success: false,
      error: 'No extracted fields to approve. Run extraction first.',
    }, { status: 400 })
  }

  // First hop: extracted → data_approved (so we have an audit
  // record of the approval even if the forward fails).
  if (row.status === 'extracted') {
    const { data: stepped, error: stepErr } = await db
      .from('inbound_invoices')
      .update({
        status: 'data_approved',
        data_reviewed_at: new Date().toISOString(),
        data_reviewed_by: user.id,
        xero_error: null,
      })
      .eq('id', id)
      .eq('status', 'extracted')
      .select('id, status')
      .single()
    if (stepErr) return NextResponse.json({ success: false, error: stepErr.message }, { status: 500 })
    if (!stepped) {
      return NextResponse.json({
        success: false,
        error: 'Row was modified concurrently — refresh and retry.',
      }, { status: 409 })
    }
  }

  // Now forward to Xero. The helper throws XeroError on
  // configuration / Postmark / storage problems.
  let forwardResult
  try {
    forwardResult = await sendInboundInvoiceBillEmail(id)
  } catch (e) {
    const msg = e instanceof XeroError ? e.message : (e?.message || String(e))
    await db
      .from('inbound_invoices')
      .update({ xero_error: msg })
      .eq('id', id)
    return NextResponse.json({ success: false, error: msg }, { status: 502 })
  }

  // Stamp success state.
  const { data: updated, error: updErr } = await db
    .from('inbound_invoices')
    .update({
      status: 'forwarded',
      forwarded_at: new Date().toISOString(),
      xero_email_message_id: forwardResult.messageId,
      xero_synced_at: new Date().toISOString(),
      xero_error: null,
    })
    .eq('id', id)
    .eq('status', 'data_approved')
    .select('id, status, forwarded_at, xero_email_message_id, xero_synced_at')
    .single()
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  if (!updated) {
    return NextResponse.json({
      success: false,
      error: 'Row was modified concurrently — refresh and retry.',
    }, { status: 409 })
  }

  return NextResponse.json({
    success: true,
    data: updated,
    forward: { sentTo: forwardResult.sentTo, filename: forwardResult.filename },
  })
}
