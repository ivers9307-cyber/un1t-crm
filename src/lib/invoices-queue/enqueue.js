// INVOICES-QUEUE.1 — enqueue helpers.
//
// Called from the owner-approval routes (FTE expenses + contractor
// invoices) and from the car-documents upload route to drop a row
// (or N rows) into the central invoices_queue. The source row's
// own status flips to 'awaiting_accountant_review' (or stays where
// it is for car_documents which have no formal approval step).
//
// All three functions follow the same shape:
//   • Validate that the source row exists + is in the right state.
//   • Build one queue row per "OCR'able document" (1 per FTE
//     receipt; 1 per contractor invoice; 1 per car document).
//   • Insert into invoices_queue with the right source_type, the
//     matching per-source FK, and the bucket where the attachment
//     physically lives.
//   • Return { ok: true, queueIds: [...] } or { ok: false, error }.
//
// We don't re-upload attachments — the queue references the
// existing storage path in the source's own bucket. PR 2's bulk
// download for OCR / Xero forward will read from
// `attachment_bucket` per-row, so no copying is required.
//
// Queue rows enter at status='quality_approved' (not 'received')
// because the owner has already approved the source — stage-1
// quality review (existing INVOICES.1 step) is the supplier-email-
// specific gate and shouldn't apply to owner-approved sources.
// PR 2 will introduce the unified state machine; for now this
// keeps the existing /invoices UI working unchanged.

import { createServerClient } from '@/lib/supabase'

const STORAGE_BUCKETS = Object.freeze({
  supplier_email: 'inbound-invoices',
  contractor_invoice: 'contractor-invoices',
  fte_expense_item: 'fte-expense-receipts',
  car_document: 'car-documents',
})

/**
 * Enqueue every receipt from an FTE expense claim. One queue row
 * per fte_expense_items row that has a receipt_path. Items without
 * a receipt are skipped silently (the bookkeeper can chase them
 * via the existing /schedule/expenses approval surface; the queue
 * is for things-with-attachments).
 *
 * Caller is responsible for first flipping the claim status to
 * 'awaiting_accountant_review' — this function does NOT touch the
 * claim row. Keeping the status flip in the route handler lets the
 * route enforce its own auth/state checks atomically.
 *
 * @param {string} claimId fte_expense_claims.id
 * @returns {Promise<{ ok: true, queueIds: string[] } | { ok: false, error: string }>}
 */
export async function enqueueFromFteExpenseClaim(claimId) {
  const db = createServerClient()

  const { data: claim, error: cErr } = await db
    .from('fte_expense_claims')
    .select('id, location_id, status')
    .eq('id', claimId)
    .maybeSingle()
  if (cErr) return { ok: false, error: `Claim lookup failed: ${cErr.message}` }
  if (!claim) return { ok: false, error: 'Claim not found.' }

  const { data: items, error: iErr } = await db
    .from('fte_expense_items')
    .select('id, claim_id, vendor, expense_date, amount, receipt_path, receipt_size_bytes, receipt_mime_type')
    .eq('claim_id', claimId)
  if (iErr) return { ok: false, error: `Items lookup failed: ${iErr.message}` }
  if (!items || items.length === 0) {
    // No items = nothing to enqueue. This isn't an error from the
    // queue's POV — the claim itself has no documents to OCR. The
    // approval route still flips claim.status; the queue just has
    // nothing to track.
    return { ok: true, queueIds: [] }
  }

  // Filter to items with receipts. An item without a receipt is a
  // claim line (e.g. a mileage entry) that doesn't need OCR or
  // bookkeeper sign-off via the queue — the operator's manager-
  // level approval is the audit record for those.
  const itemsWithReceipts = items.filter((it) => it.receipt_path)
  if (itemsWithReceipts.length === 0) return { ok: true, queueIds: [] }

  const rows = itemsWithReceipts.map((it) => ({
    location_id: claim.location_id,
    source_type: 'fte_expense_item',
    source_fte_expense_item_id: it.id,
    attachment_bucket: STORAGE_BUCKETS.fte_expense_item,
    attachment_path: it.receipt_path,
    attachment_filename: it.receipt_path?.split('/').pop() || null,
    attachment_size_bytes: it.receipt_size_bytes || null,
    attachment_mime_type: it.receipt_mime_type || null,
    // Sender/subject derived for the inbox UI display. Supplier
    // emails carry these from Postmark; FTE rows synthesise them
    // so the same row component renders consistently.
    sender_email: null,
    subject: it.vendor ? `${it.vendor}${it.expense_date ? ` · ${it.expense_date}` : ''}` : 'FTE expense receipt',
    // Skip stage-1 quality review — owner has already approved.
    status: 'quality_approved',
  }))

  const { data: inserted, error: insErr } = await db
    .from('invoices_queue')
    .insert(rows)
    .select('id')
  if (insErr) return { ok: false, error: `Queue insert failed: ${insErr.message}` }

  return { ok: true, queueIds: (inserted || []).map((r) => r.id) }
}

/**
 * Enqueue a single contractor invoice for accountant review. The
 * contractor_invoices row carries `pdf_path` (mig 101) — that's
 * the attachment we hand off to the queue.
 *
 * @param {string} invoiceId contractor_invoices.id
 */
export async function enqueueFromContractorInvoice(invoiceId) {
  const db = createServerClient()

  const { data: inv, error: cErr } = await db
    .from('contractor_invoices')
    .select(`
      id, location_id, status, invoice_number, invoice_amount,
      period_start, period_end, pdf_path,
      contractor:contractor_id ( id, full_name, email )
    `)
    .eq('id', invoiceId)
    .maybeSingle()
  if (cErr) return { ok: false, error: `Invoice lookup failed: ${cErr.message}` }
  if (!inv) return { ok: false, error: 'Contractor invoice not found.' }
  if (!inv.pdf_path) {
    // Defensive — contractor invoice approval shouldn't reach this
    // path without a PDF, but the column is nullable in the schema
    // so guard anyway. Queue row needs SOMETHING to OCR.
    return { ok: false, error: 'Contractor invoice has no PDF attachment.' }
  }

  const contractorName = inv.contractor?.full_name || 'Contractor'
  const { data: inserted, error: insErr } = await db
    .from('invoices_queue')
    .insert({
      location_id: inv.location_id,
      source_type: 'contractor_invoice',
      source_contractor_invoice_id: inv.id,
      attachment_bucket: STORAGE_BUCKETS.contractor_invoice,
      attachment_path: inv.pdf_path,
      attachment_filename: inv.pdf_path?.split('/').pop() || null,
      attachment_size_bytes: null,
      attachment_mime_type: 'application/pdf',
      sender_email: inv.contractor?.email || null,
      subject: `${contractorName} — ${inv.period_start || ''}${inv.invoice_number ? ` · ${inv.invoice_number}` : ''}`.trim(),
      status: 'quality_approved',
    })
    .select('id')
    .single()
  if (insErr) return { ok: false, error: `Queue insert failed: ${insErr.message}` }
  return { ok: true, queueIds: [inserted.id] }
}

/**
 * Enqueue a car document on upload. No explicit approval step for
 * car documents today — they auto-queue (same shape as supplier
 * emails). The car-documents bucket holds the file; the queue row
 * references it.
 *
 * @param {string} documentId car_documents.id
 */
export async function enqueueFromCarDocument(documentId) {
  const db = createServerClient()

  const { data: doc, error: cErr } = await db
    .from('car_documents')
    .select(`
      id, car_id, storage_path, filename, mime_type, size_bytes,
      car:car_id ( id, location_id, make, model, uk_reg, irish_reg )
    `)
    .eq('id', documentId)
    .maybeSingle()
  if (cErr) return { ok: false, error: `Document lookup failed: ${cErr.message}` }
  if (!doc) return { ok: false, error: 'Car document not found.' }
  if (!doc.car?.location_id) return { ok: false, error: 'Car document has no associated car location.' }
  if (!doc.storage_path) return { ok: false, error: 'Car document has no storage_path.' }

  const carLabel = [doc.car?.make, doc.car?.model, doc.car?.uk_reg || doc.car?.irish_reg]
    .filter(Boolean)
    .join(' ') || 'Car document'

  const { data: inserted, error: insErr } = await db
    .from('invoices_queue')
    .insert({
      location_id: doc.car.location_id,
      source_type: 'car_document',
      source_car_document_id: doc.id,
      attachment_bucket: STORAGE_BUCKETS.car_document,
      attachment_path: doc.storage_path,
      attachment_filename: doc.filename || doc.storage_path?.split('/').pop() || null,
      attachment_size_bytes: doc.size_bytes || null,
      attachment_mime_type: doc.mime_type || null,
      sender_email: null,
      subject: carLabel,
      // Car documents auto-queue without owner approval (same as
      // supplier emails). Bookkeeper still reviews before Xero.
      status: 'received',
    })
    .select('id')
    .single()
  if (insErr) return { ok: false, error: `Queue insert failed: ${insErr.message}` }
  return { ok: true, queueIds: [inserted.id] }
}
