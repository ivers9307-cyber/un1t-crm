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
import { dublinTodayStr } from '@/lib/dublin-time'

const STORAGE_BUCKETS = Object.freeze({
  supplier_email: 'inbound-invoices',
  contractor_invoice: 'contractor-invoices',
  fte_expense_item: 'fte-expense-receipts',
  car_document: 'car-documents',
  card_receipt: 'company-card-receipts',
  email_hunt: 'hunted-invoices',
})

// CONTRACTOR-MIME.1 — extension → mime, for the sources that store a path
// and nothing else. Only the five types Anthropic accepts (plus the HEIC
// pair, which extractInvoiceFieldsFromBytes converts): anything else
// resolves to null, which surfaces downstream as a clear "Unsupported MIME
// type for OCR" instead of a confident wrong answer.
const MIME_BY_EXT = Object.freeze({
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
})

function mimeFromPath(path) {
  const name = String(path || '').split('/').pop() || ''
  if (!name.includes('.')) return null
  return MIME_BY_EXT[name.split('.').pop().toLowerCase()] || null
}

/**
 * Resolve an attachment's real mime + size.
 *
 * Every enqueue path but one reads these off its source row
 * (`receipt_mime_type`, `doc.mime_type`, …). Contractor invoices have no
 * such columns — the table stores only `pdf_path` — so that path
 * hard-coded 'application/pdf' and a null size. Contractors upload phone
 * photos: a .png went out labelled PDF, was sent to Anthropic as a
 * `document` block, and came back "The PDF specified was not valid"
 * (queue row ad57c308). The label was the only thing wrong with it.
 *
 * Storage is the authority — it records the content type observed at
 * upload (it had this file correct as image/png) and the byte size, which
 * is why it is tried first. The lookup is best-effort in every sense: any
 * failure falls back to the file extension, and enqueue NEVER fails because
 * metadata could not be read. A queue row with an imperfect mime is
 * recoverable; a missing queue row is an invoice nobody gets paid for.
 *
 * @returns {Promise<{ mime: string|null, size: number|null }>}
 */
async function resolveAttachmentMeta(db, bucket, path) {
  const fallback = { mime: mimeFromPath(path), size: null }
  if (!bucket || !path) return fallback
  try {
    const parts = String(path).split('/')
    const name = parts.pop()
    const { data, error } = await db.storage.from(bucket).list(parts.join('/'), { search: name })
    if (error) return fallback
    const hit = (data || []).find((o) => o.name === name)
    const mime = hit?.metadata?.mimetype
    const size = Number(hit?.metadata?.size)
    return {
      // A generic octet-stream tells us nothing the extension doesn't.
      mime: mime && mime !== 'application/octet-stream' ? mime : fallback.mime,
      size: Number.isFinite(size) && size > 0 ? size : null,
    }
  } catch {
    return fallback
  }
}

/**
 * Build a synthetic extracted_fields payload for a receiptless
 * expense item (mileage, cash-in-hand, etc). We have the
 * submitter's typed vendor + amount + date, which is everything
 * the bookkeeper needs to push to Xero — there's just no scanned
 * receipt for Claude Vision to OCR.
 *
 * Returns an object matching invoiceFieldsSchema's required fields
 * so the row can be marked status='extracted' and skip the Analyse
 * stage entirely. The bookkeeper still reviews + picks Xero refs
 * before send.
 *
 * RECEIPTLESS-EXPENSE-QUEUE — added so receiptless items appear in
 * the bookkeeper queue. Previously they were silently dropped and
 * the claim got stuck in 'awaiting_accountant_review' with nothing
 * for the bookkeeper to act on.
 */
function syntheticFieldsForReceiptlessItem(item) {
  const amount = Number(item.amount) || 0
  const supplier = (item.vendor && String(item.vendor).trim()) || 'Mileage / cash expense'
  const invoiceDate = item.expense_date || dublinTodayStr()
  // Synthetic invoice number — stable + unique within Xero, with
  // an EXP- prefix so the bookkeeper can tell it's a synthesised
  // reference (not a real invoice number).
  const invoiceNumber = `EXP-${String(item.id).slice(0, 8).toUpperCase()}`
  return {
    supplier_name: supplier,
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    currency: 'EUR',
    subtotal: amount,
    tax_amount: 0,
    total: amount,
    line_items: [{
      description: supplier,
      quantity: 1,
      unit_amount: amount,
    }],
  }
}

/**
 * Enqueue every item from an FTE expense claim. One queue row per
 * fte_expense_items row, regardless of whether the item has a
 * receipt:
 *   • Items WITH receipts land at status='quality_approved' with
 *     the attachment pointer set; bookkeeper clicks Analyse →
 *     Claude Vision → extracted_fields populated.
 *   • Items WITHOUT receipts land at status='extracted' with
 *     synthetic extracted_fields built from the submitter's typed
 *     vendor + amount + date. No Analyse needed; bookkeeper just
 *     picks Xero refs + sends.
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

  // RECEIPTLESS-EXPENSE-QUEUE — queue ALL items. Items with
  // receipts go through the normal Analyse → Send flow; receiptless
  // items land pre-extracted (from the typed item data) so the
  // bookkeeper can review + send without a no-op Analyse click.
  const rows = items.map((it) => {
    const hasReceipt = !!it.receipt_path
    const base = {
      location_id: claim.location_id,
      source_type: 'fte_expense_item',
      source_fte_expense_item_id: it.id,
      // attachment_bucket is NOT NULL — set the FTE bucket even
      // for receiptless rows so the column constraint is honoured.
      // attachment_path stays null and the queue UI skips the
      // attachment preview / Analyse for these rows.
      attachment_bucket: STORAGE_BUCKETS.fte_expense_item,
      attachment_path: hasReceipt ? it.receipt_path : null,
      attachment_filename: hasReceipt ? (it.receipt_path?.split('/').pop() || null) : null,
      attachment_size_bytes: hasReceipt ? (it.receipt_size_bytes || null) : null,
      attachment_mime_type: hasReceipt ? (it.receipt_mime_type || null) : null,
      // Sender/subject derived for the inbox UI display. Supplier
      // emails carry these from Postmark; FTE rows synthesise them
      // so the same row component renders consistently.
      sender_email: null,
      subject: it.vendor
        ? `${it.vendor}${it.expense_date ? ` · ${it.expense_date}` : ''}${hasReceipt ? '' : ' (no receipt)'}`
        : (hasReceipt ? 'FTE expense receipt' : 'FTE expense (no receipt)'),
    }
    if (hasReceipt) {
      // Skip stage-1 quality review — owner has already approved.
      // Bookkeeper picks the row up, clicks Analyse, Vision runs.
      return { ...base, status: 'quality_approved' }
    }
    // Receiptless: there's nothing to OCR. Skip straight to
    // 'extracted' with synthetic fields so the bookkeeper sees the
    // row ready for review + send.
    return {
      ...base,
      status: 'extracted',
      extracted_at: new Date().toISOString(),
      extraction_confidence: 'high', // it's not OCR'd, it's the submitter's typed data
      extracted_fields: syntheticFieldsForReceiptlessItem(it),
    }
  })

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
  // CONTRACTOR-MIME.1 — `pdf_path` is a historical name, not a guarantee:
  // contractors submit phone photos too. Resolve what the file actually is
  // instead of asserting PDF (which produced an Anthropic 400 that read as
  // a corrupt document rather than a wrong label).
  const attachment = await resolveAttachmentMeta(db, STORAGE_BUCKETS.contractor_invoice, inv.pdf_path)
  const { data: inserted, error: insErr } = await db
    .from('invoices_queue')
    .insert({
      location_id: inv.location_id,
      source_type: 'contractor_invoice',
      source_contractor_invoice_id: inv.id,
      attachment_bucket: STORAGE_BUCKETS.contractor_invoice,
      attachment_path: inv.pdf_path,
      attachment_filename: inv.pdf_path?.split('/').pop() || null,
      attachment_size_bytes: attachment.size,
      attachment_mime_type: attachment.mime,
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

/**
 * Enqueue a single company-card receipt (SPEND.P3.1). Card receipts
 * ride the emailed-invoice path: the submitter only provides the
 * receipt photo, so the row enters at status 'received' (like a
 * supplier email / car document) and the bookkeeper's Analyse (Claude
 * Vision OCR) fills the fields in /invoices, then reviews + sends to
 * Xero. There is no owner-approval step — the bookkeeper's queue review
 * IS the approval.
 *
 * Called from the finalise route immediately on submit (auto-enqueue).
 *
 * @param {string} receiptId card_receipts.id
 */
export async function enqueueFromCardReceipt(receiptId) {
  const db = createServerClient()

  const { data: rec, error: rErr } = await db
    .from('card_receipts')
    .select(`
      id, location_id, card_last4, receipt_path, receipt_size_bytes, receipt_mime_type,
      submitter:submitter_id ( id, full_name, email )
    `)
    .eq('id', receiptId)
    .maybeSingle()
  if (rErr) return { ok: false, error: `Card receipt lookup failed: ${rErr.message}` }
  if (!rec) return { ok: false, error: 'Card receipt not found.' }
  if (!rec.receipt_path) {
    return { ok: false, error: 'Card receipt has no attachment.' }
  }

  // No merchant/amount/date yet — those come from the bookkeeper's
  // Analyse. The subject just identifies who submitted it (+ which card)
  // for the queue's inbox display.
  const submitterName = rec.submitter?.full_name || 'staff member'
  const cardTag = rec.card_last4 ? ` · card ••${rec.card_last4}` : ''
  const { data: inserted, error: insErr } = await db
    .from('invoices_queue')
    .insert({
      location_id: rec.location_id,
      source_type: 'card_receipt',
      source_card_receipt_id: rec.id,
      attachment_bucket: STORAGE_BUCKETS.card_receipt,
      attachment_path: rec.receipt_path,
      attachment_filename: rec.receipt_path?.split('/').pop() || null,
      attachment_size_bytes: rec.receipt_size_bytes || null,
      attachment_mime_type: rec.receipt_mime_type || null,
      sender_email: rec.submitter?.email || null,
      subject: `Company-card receipt — ${submitterName}${cardTag}`,
      // Raw inbound, exactly like a supplier email: needs Analyse.
      status: 'received',
    })
    .select('id')
    .single()
  if (insErr) return { ok: false, error: `Queue insert failed: ${insErr.message}` }
  return { ok: true, queueIds: [inserted.id] }
}

// RCOV.P1 — enqueue a hunted email attachment. content_hash dedupe:
// if ANY queue row (any source) already carries this hash, DO NOT
// insert — return that row's id with deduped:true so the caller links
// the bank line to the existing document instead. This is the
// cross-source duplicate guard (same invoice arriving via email hunt
// AND card photo/supplier email must not become two Xero bills).
export async function enqueueFromHuntFind({
  locationId, huntId, bucketPath, filename, sizeBytes, mimeType,
  senderEmail, subject, contentHash,
}) {
  const db = createServerClient()

  if (!contentHash) return { ok: false, error: 'contentHash is required.' }
  if (!huntId) return { ok: false, error: 'huntId is required.' }
  if (!bucketPath) return { ok: false, error: 'bucketPath is required.' }

  const { data: existing, error: dupErr } = await db
    .from('invoices_queue')
    .select('id, status')
    .eq('content_hash', contentHash)
    .limit(1)
    .maybeSingle()
  if (dupErr) return { ok: false, error: `Hash lookup failed: ${dupErr.message}` }
  if (existing) return { ok: true, queueIds: [existing.id], deduped: true }

  const { data: inserted, error: insErr } = await db
    .from('invoices_queue')
    .insert({
      location_id: locationId,
      source_type: 'email_hunt',
      source_hunt_id: huntId,
      attachment_bucket: STORAGE_BUCKETS.email_hunt,
      attachment_path: bucketPath,
      attachment_filename: filename || null,
      attachment_size_bytes: sizeBytes || null,
      attachment_mime_type: mimeType || null,
      sender_email: senderEmail || null,
      subject: subject || 'Hunted invoice',
      status: 'received',
      content_hash: contentHash,
    })
    .select('id')
    .single()
  if (insErr) return { ok: false, error: `Queue insert failed: ${insErr.message}` }
  return { ok: true, queueIds: [inserted.id], deduped: false }
}
