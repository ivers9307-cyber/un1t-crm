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
import { recordSupplierDefault } from '@/lib/invoices-queue/supplier-defaults'
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
    if (stepErr) return NextResponse.json({ success: false, error: stepErr.message }, { status: 500 })
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
      const ef = row.extracted_fields || {}
      const ref = ef.xero_contact_ref
      if (ref?.kind === 'existing' && ref.xero_contact_id && ef.xero_account_id) {
        await recordSupplierDefault(db, {
          locationId: row.location_id,
          xeroContactId: ref.xero_contact_id,
          supplierName: ref.name || ef.supplier_name || null,
          accountCode: ef.account_code || null,
          xeroAccountId: ef.xero_account_id,
          category: ef.category || null,
        })
      }
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
    return NextResponse.json({ success: false, error: msg }, { status: 502 })
  }

  // The bill was created in Xero, but the source file failed to
  // attach. Do NOT mark it forwarded — the source must travel to Xero
  // (the CRM is the sole path now that Dext is being retired). Persist
  // the bill id (so a retry re-attaches to the SAME bill instead of
  // creating a duplicate) and surface the reason; the row stays in
  // data_approved with a Retry button.
  if (pushResult.attachmentError) {
    await db
      .from('invoices_queue')
      .update({
        xero_bill_id: pushResult.billId,
        xero_bill_number: pushResult.billNumber,
        xero_deep_link_url: pushResult.deepLinkUrl,
        xero_synced_at: new Date().toISOString(),
        xero_error: `Bill created in Xero, but attaching the source file failed: ${pushResult.attachmentError}. Click "Retry send to Xero" to attach it.`,
      })
      .eq('id', id)
    return NextResponse.json({
      success: false,
      error: `Bill created in Xero, but the source file didn't attach: ${pushResult.attachmentError}. Retry to attach it.`,
    }, { status: 502 })
  }

  // Stamp success state with the bill_id + deep link.
  const { data: updated, error: updErr } = await db
    .from('invoices_queue')
    .update({
      status: 'forwarded',
      forwarded_at: new Date().toISOString(),
      xero_bill_id: pushResult.billId,
      xero_bill_number: pushResult.billNumber,
      xero_deep_link_url: pushResult.deepLinkUrl,
      xero_synced_at: new Date().toISOString(),
      xero_error: null,
    })
    .eq('id', id)
    .eq('status', 'data_approved')
    .select('id, status, forwarded_at, xero_bill_id, xero_bill_number, xero_deep_link_url, xero_synced_at')
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
    push: {
      billId: pushResult.billId,
      billNumber: pushResult.billNumber,
      deepLinkUrl: pushResult.deepLinkUrl,
      sentTo: pushResult.sentTo,
    },
  })
}
