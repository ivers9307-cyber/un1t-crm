// INVOICES.1 — Claude Vision extraction.
//
// Manual trigger from the inbox UI after a stage-1 quality approve.
// The /quality-approve route puts the row in quality_approved; this
// route downloads the attachment, calls Claude Vision via the shared
// invoice-extraction.js helper, and on success advances the row to
// 'extracted'. On failure the row STAYS in quality_approved so the
// UI can surface a retry button.
//
// Why manual rather than auto-firing on quality-approve:
//   • Cost protection. The operator chose to extract. A bad-quality
//     attachment that slipped through stage 1 gets caught before
//     Claude is billed.
//   • Matches the FTE expense + contractor invoice OCR pattern that
//     was just converted from auto to manual.
//
// Idempotency: if the row already has extracted_fields and the
// caller hits /extract again, we re-run — useful when the operator
// updates the attachment (future feature) or wants a fresh pass.
// The xero forward step downstream is the one that's protected
// against double-fire.

import { NextResponse } from 'next/server'
import { loadInvoiceForUser } from '../../_helpers'
import { extractInvoiceFieldsFromBytes } from '@/lib/invoice-extraction'
import { canTransitionInboundInvoice } from '@/lib/inbound-invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'inbound-invoices'

export async function POST(_request, { params }) {
  const { id } = await params
  const ctx = await loadInvoiceForUser(id)
  if (ctx.response) return ctx.response
  const { db, row } = ctx

  // Legal states: quality_approved (first run) or extracted (re-run).
  if (row.status !== 'quality_approved' && row.status !== 'extracted') {
    return NextResponse.json({
      success: false,
      error: `Cannot extract from '${row.status}' state. Quality-approve first.`,
    }, { status: 409 })
  }
  // We're going to land in 'extracted' regardless of whether the
  // current state is quality_approved or extracted; transition
  // map sanity check just for the first hop.
  if (row.status === 'quality_approved' && !canTransitionInboundInvoice(row.status, 'extracted')) {
    return NextResponse.json({ success: false, error: 'Illegal transition.' }, { status: 409 })
  }
  if (!row.attachment_path) {
    return NextResponse.json({ success: false, error: 'Row has no attachment.' }, { status: 400 })
  }

  // Pull the bytes. Service-role bypasses RLS.
  const { data: blob, error: dlErr } = await db.storage
    .from(STORAGE_BUCKET)
    .download(row.attachment_path)
  if (dlErr || !blob) {
    return NextResponse.json({
      success: false,
      error: `Could not download attachment: ${dlErr?.message || 'unknown error'}`,
    }, { status: 500 })
  }
  const ab = await blob.arrayBuffer()
  const bytes = Buffer.from(ab)

  const result = await extractInvoiceFieldsFromBytes(bytes, row.attachment_mime_type)
  if (!result.ok) {
    // Persist the error so the inbox shows it; keep the row in
    // quality_approved so the operator can retry without re-doing
    // the legibility approve.
    await db
      .from('inbound_invoices')
      .update({
        extraction_error: result.error,
        extracted_at: new Date().toISOString(),
      })
      .eq('id', id)
    return NextResponse.json({ success: false, error: result.error }, { status: 422 })
  }

  // Confidence — coarse heuristic. The Claude prompt asks for
  // canonical fields; if everything required is present we call it
  // high. If subtotal+tax doesn't reconcile to total within €0.01
  // OR a required field is missing we call it medium. Operator
  // always reviews regardless, so this is just a UI hint.
  const f = result.fields
  const reconciles = Math.abs((Number(f.subtotal) + Number(f.tax_amount)) - Number(f.total)) <= 0.01
  const allRequired = f.supplier_name && f.invoice_number && f.invoice_date && Number.isFinite(Number(f.total))
  const confidence = allRequired && reconciles ? 'high' : 'medium'

  const { data: updated, error: updErr } = await db
    .from('inbound_invoices')
    .update({
      status: 'extracted',
      extracted_at: new Date().toISOString(),
      extracted_fields: result.fields,
      extraction_confidence: confidence,
      extraction_error: null,
    })
    .eq('id', id)
    .in('status', ['quality_approved', 'extracted'])
    .select('id, status, extracted_at, extracted_fields, extraction_confidence')
    .single()
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  if (!updated) {
    return NextResponse.json({
      success: false,
      error: 'Row was modified concurrently — refresh and retry.',
    }, { status: 409 })
  }
  return NextResponse.json({ success: true, data: updated })
}
