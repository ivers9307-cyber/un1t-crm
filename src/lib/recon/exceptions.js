// src/lib/recon/exceptions.js
//
// RCOV.P2 — detection queries behind the /accounting Exceptions tab,
// closing the 2026-07-03 receipt-pipeline audit findings:
//   F2 vatMismatches — Xero booked a different tax figure than the
//      OCR read (flag written at push time by push-xero.js).
//   F3 agingDrafts — bills forwarded >7d ago still DRAFT in Xero
//      (drafts are invisible to VAT returns and unmatchable).
//   F5 unattached — bill created but the source document never
//      attached (status stays data_approved with xero_bill_id set —
//      that exact state IS the detection, no string matching).
//   F4 receiptless — expense items that legitimately carry no
//      document (mileage/cash); surfaced so a coverage check doesn't
//      read them as missing receipts.
//   stuckRows — queue rows sitting non-terminal >7d (workflow stall).
//
// All sections are display-capped at 100 (well under the 1k select
// cap); every query error throws with a greppable section name.
const SECTION_LIMIT = 100
const STALE_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export async function getExceptions(db, locationId) {
  const staleBefore = new Date(Date.now() - STALE_DAYS_MS).toISOString()

  const { data: vatMismatches, error: vatErr } = await db
    .from('invoices_queue')
    .select('id, subject, xero_total_tax, extracted_fields, xero_deep_link_url, forwarded_at')
    .eq('location_id', locationId)
    .eq('xero_tax_mismatch', true)
    .order('forwarded_at', { ascending: false })
    .limit(SECTION_LIMIT)
  if (vatErr) throw new Error(`exceptions vatMismatches failed: ${vatErr.message}`)

  const { data: agingDrafts, error: draftErr } = await db
    .from('invoices_queue')
    .select('id, subject, xero_bill_number, xero_deep_link_url, forwarded_at, xero_bill_status_synced_at')
    .eq('location_id', locationId)
    .eq('status', 'forwarded')
    .eq('xero_bill_status', 'DRAFT')
    .lt('forwarded_at', staleBefore)
    .order('forwarded_at', { ascending: true })
    .limit(SECTION_LIMIT)
  if (draftErr) throw new Error(`exceptions agingDrafts failed: ${draftErr.message}`)

  const { data: unattached, error: unattachedErr } = await db
    .from('invoices_queue')
    .select('id, subject, xero_bill_number, xero_deep_link_url, xero_error')
    .eq('location_id', locationId)
    .eq('status', 'data_approved')
    .not('xero_bill_id', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(SECTION_LIMIT)
  if (unattachedErr) throw new Error(`exceptions unattached failed: ${unattachedErr.message}`)

  const { data: receiptless, error: receiptlessErr } = await db
    .from('invoices_queue')
    .select('id, subject, status, forwarded_at')
    .eq('location_id', locationId)
    .eq('source_type', 'fte_expense_item')
    .is('attachment_path', null)
    .in('status', ['extracted', 'data_approved', 'forwarded'])
    .order('received_at', { ascending: false })
    .limit(SECTION_LIMIT)
  if (receiptlessErr) throw new Error(`exceptions receiptless failed: ${receiptlessErr.message}`)

  const { data: stuckRows, error: stuckErr } = await db
    .from('invoices_queue')
    .select('id, subject, status, received_at')
    .eq('location_id', locationId)
    .in('status', ['received', 'quality_approved', 'extracted', 'data_approved'])
    .lt('received_at', staleBefore)
    .order('received_at', { ascending: true })
    .limit(SECTION_LIMIT)
  if (stuckErr) throw new Error(`exceptions stuckRows failed: ${stuckErr.message}`)

  return {
    vatMismatches: (vatMismatches || []).map((r) => ({
      id: r.id,
      subject: r.subject,
      xero_total_tax: r.xero_total_tax,
      ocr_tax: r.extracted_fields?.tax_amount ?? null,
      xero_deep_link_url: r.xero_deep_link_url,
      forwarded_at: r.forwarded_at,
    })),
    agingDrafts: agingDrafts || [],
    unattached: unattached || [],
    receiptless: receiptless || [],
    stuckRows: stuckRows || [],
  }
}
