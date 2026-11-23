// INV-M.1 — pure helpers for the mobile bookkeeper queue screen
// (app/invoices/queue.jsx). Mirrors the web /invoices inbox logic in
// src/components/InvoicesInbox.jsx ("Extract selected" queues every row) and
// src/components/invoices/XeroContactPicker.jsx (XERO-CONTACT-RED.1
// unresolved-supplier flag). Mobile can't import src/, so the rules
// are re-encoded here — keep the two in sync if the web rules move.
//
// No React/Supabase — the root vitest picks this up (config includes
// mobile/lib/**).

// The invoices_queue statuses that still need bookkeeper action —
// same set as the web inbox's "Awaiting action" filter (and the
// invoices-queue approvals provider's PENDING_STATUSES).
export const PENDING_STATUSES = ['received', 'quality_approved', 'extracted', 'data_approved']

/**
 * Can this row be sent for extraction? Same predicate as the web
 * "Extract selected" filter: pre-extraction status, not already
 * claimed by the background analyser. (Queued-but-unclaimed rows may
 * be re-sent — the server clears stale queue flags.)
 */
export function isExtractable(row) {
  if (!row) return false
  return ['received', 'quality_approved'].includes(row.status) && !row.analysis_claimed_at
}

/**
 * XERO-CONTACT-RED.1 (mobile mirror) — is the row's Xero supplier
 * contact unresolved? Only a picked EXISTING Xero contact counts as
 * resolved (kind 'existing'); nothing picked, or a to-be-created
 * sentinel (kind 'new'), both hold up / red-flag the send-to-Xero.
 * Only meaningful once fields exist (extracted / data_approved).
 */
export function xeroSupplierUnresolved(row) {
  if (!row) return false
  if (!['extracted', 'data_approved'].includes(row.status)) return false
  const ref = row.extracted_fields?.xero_contact_ref
  return !ref || ref.kind !== 'existing'
}

/**
 * INVMOBILE.1 — the queue route's counts in the screen's summary shape:
 * { queued, failed, skipped } with zero-count keys omitted. `data` is the
 * bulk-queue-analysis `.data` payload.
 */
export function queueCounts(data) {
  const counts = {}
  for (const k of ['queued', 'failed', 'skipped']) {
    const n = Number(data?.counts?.[k]) || 0
    if (n) counts[k] = n
  }
  return counts
}

/**
 * Status pill meta for a queue row — label + tone. Mirrors the web
 * StatusPill including the live queued/analysing sub-state override
 * (INV-BULK.3). Tones map to nativewind chip classes in the screen.
 */
export function queueStatusMeta(row) {
  if (!row) return { label: '', tone: 'slate' }
  if (row.analysis_queued_at && ['received', 'quality_approved'].includes(row.status)) {
    return row.analysis_claimed_at
      ? { label: 'Analysing…', tone: 'blue' }
      : { label: 'Queued', tone: 'amber' }
  }
  const map = {
    received: { label: 'Awaiting review', tone: 'amber' },
    quality_approved: { label: 'Awaiting extract', tone: 'blue' },
    extracted: { label: 'Awaiting data', tone: 'blue' },
    data_approved: { label: 'Awaiting send', tone: 'purple' },
  }
  return map[row.status] || { label: row.status, tone: 'slate' }
}

// Friendly source labels — keys match invoices_queue.source_type
// (same map as the web inbox / approvals provider).
export const SOURCE_LABEL = {
  supplier_email: 'Supplier',
  contractor_invoice: 'Contractor',
  fte_expense_item: 'Expense',
  card_receipt: 'Card receipt',
  car_document: 'Car',
}
