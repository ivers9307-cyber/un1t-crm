// INVOICES.1 stage 2 approve — operator confirms the extracted
// fields are correct. Moves extracted → data_approved → forwarded
// (the latter happens synchronously inside this route after the
// Xero push lands).
//
// On Xero push success → status='forwarded' with xero_bill_id +
//   xero_deep_link_url stamped.
// On Xero push failure → row stays in data_approved with
//   xero_error populated so the inbox shows a retry button.
//
// XERO-API.3 — swapped from the Postmark/Hubdoc email forward to
// direct /Invoices API push. The push helper enforces the
// account + supplier picks server-side.

import { NextResponse } from 'next/server'
import { loadInvoiceForUser } from '../../_helpers'
import { canTransitionInboundInvoice } from '@/lib/inbound-invoices'
import { pushQueueRowToXero } from '@/lib/invoices-queue/push-xero'
import { hasResolvedVatRate } from '@/lib/invoices-queue/vat'
import { recordPushOutcome, rememberSupplierCoding } from '@/lib/invoices-queue/push-outcome'
import { XeroError } from '@/lib/xero/client'
import { serverErrorResponse } from '@/lib/error-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, { params }) {
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

  // XERO-BILL-VAT.2 — never send a bill whose VAT rate is undetermined.
  // A confirmed tax_type is required, EXCEPT a genuine 0%-VAT bill, which
  // push resolves to 'NONE' deterministically. Same gate as bulk-send.
  if (!hasResolvedVatRate(row.extracted_fields)) {
    return NextResponse.json({
      success: false,
      error: 'Pick a VAT rate before sending — the bill’s rate couldn’t be auto-determined. Open the bill and choose a VAT rate.',
    }, { status: 400 })
  }

  // First hop: extracted → data_approved (so we have an audit
  // record of the approval even if the forward fails).
  if (row.status === 'extracted') {
    const { data: stepped, error: stepErr } = await db
      .from('invoices_queue')
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
    if (stepErr) return serverErrorResponse({ module: 'invoice-data-approve', error: stepErr, request })
    if (!stepped) {
      return NextResponse.json({
        success: false,
        error: 'Row was modified concurrently — refresh and retry.',
      }, { status: 409 })
    }

    // SUPPLIER-MEMORY.1 — remember this supplier's coding so the next
    // invoice from them pre-fills. Best-effort: a write failure must
    // never block the approval. Recorded once, on the first approval.
    try {
      await rememberSupplierCoding(db, row)
    } catch (e) {
      console.warn(`[data-approve ${id}] recordSupplierDefault failed: ${e?.message || e}`)
    }
  }

  // XERO-API.3 — push directly to /Invoices. The helper throws
  // XeroError on missing refs (the picks from PR 2), token /
  // network failure, or Xero-side validation. The row stays at
  // data_approved so the inbox UI shows a retry button.
  let pushResult
  try {
    pushResult = await pushQueueRowToXero(id)
  } catch (e) {
    const msg = e instanceof XeroError ? e.message : (e?.message || String(e))
    await db
      .from('invoices_queue')
      .update({ xero_error: msg })
      .eq('id', id)
    // OBS-HANDLED.1 — the Xero push failure now leaves an error_events
    // row (this exact 502 fired in prod with zero observability rows).
    return serverErrorResponse({ module: 'invoice-data-approve', error: e, request, status: 502, publicMessage: msg })
  }

  // XEROBULK.1 — the shared outcome (also the bulk route's). A bill whose
  // source file did not attach is NOT forwarded: it keeps its bill id (so a
  // retry re-attaches to the SAME bill) and stays in data_approved.
  const recorded = await recordPushOutcome(db, id, pushResult, {
    select: 'id, status, forwarded_at, xero_bill_id, xero_bill_number, xero_deep_link_url, xero_synced_at',
  })
  if (recorded.outcome === 'attachment_failed') {
    return serverErrorResponse({
      module: 'invoice-data-approve',
      error: { name: 'XeroAttachmentError', message: `Bill created but source file failed to attach: ${pushResult.attachmentError}` },
      request,
      status: 502,
      publicMessage: `Bill created in Xero, but the source file didn't attach: ${pushResult.attachmentError}. Retry to attach it.`,
    })
  }
  if (recorded.outcome === 'error') return serverErrorResponse({ module: 'invoice-data-approve', error: { message: recorded.message }, request })
  if (recorded.outcome === 'conflict') {
    return NextResponse.json({
      success: false,
      error: 'Row was modified concurrently — refresh and retry.',
    }, { status: 409 })
  }
  const updated = recorded.row

  return NextResponse.json({
    success: true,
    data: updated,
    push: {
      billId: pushResult.billId,
      billNumber: pushResult.billNumber,
      deepLinkUrl: pushResult.deepLinkUrl,
      sentTo: pushResult.sentTo,
    },
  })
}
