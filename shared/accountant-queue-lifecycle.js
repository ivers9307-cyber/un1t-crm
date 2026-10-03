// EXPENSELIFE.1 — the honest "where is it now" label for anything an
// owner approves into the accountant's invoices_queue. Pure: no DB, no
// network, no platform imports, so the API routes compute it and web +
// phone render the same verdict.
//
// Two documents ride the queue today, and both used to read "With
// accountant" (or similar) forever after approval, because the owner's
// approval flips the SOURCE row to 'awaiting_accountant_review' and
// nothing ever moves it again. The real progress lives on the queue:
//
//   status: quality_approved → extracted → data_approved → forwarded
//                                                        ↘ rejected
//   xero_bill_id / forwarded_at      set when the bookkeeper sends it
//   xero_bill_status / _paid_at      set by the Xero webhook (mig 208);
//                                    the ONLY paid signal in the data
//
//   • contractor invoice → ONE queue row (source_contractor_invoice_id)
//   • FTE expense claim  → ONE ROW PER ITEM (source_fte_expense_item_id,
//     enqueueFromFteExpenseClaim). The bookkeeper handles each receipt
//     separately, so a claim's items can sit in different states and
//     the claim label has to aggregate them without over-claiming.
//
// Every label here stops at what the data can prove. A queue READ that
// failed is `undefined` and yields plain "Approved", never a guess.

export const LIFECYCLE = Object.freeze({
  approved: { key: 'approved', label: 'Approved', tone: 'green' },
  approved_not_queued: { key: 'approved_not_queued', label: 'Approved, not yet queued for accountant', tone: 'amber' },
  queued_for_accountant: { key: 'queued_for_accountant', label: 'Approved, queued for accountant', tone: 'green' },
  rejected_by_accountant: { key: 'rejected_by_accountant', label: 'Approved, rejected by accountant', tone: 'red' },
  voided_in_xero: { key: 'voided_in_xero', label: 'Voided in Xero', tone: 'slate' },
  sent_to_xero: { key: 'sent_to_xero', label: 'Sent to Xero', tone: 'green' },
  paid: { key: 'paid', label: 'Paid', tone: 'green' },
})

function lc(key) {
  return { ...LIFECYCLE[key] }
}

/**
 * Lifecycle of ONE queue row.
 *
 * @param {object|null|undefined} queue
 *   undefined → not looked up / lookup failed (don't claim either way)
 *   null      → looked up, none exists (the enqueue failed)
 *   object    → { status, forwarded_at, xero_bill_id,
 *                 xero_bill_status, xero_bill_paid_at }
 * @returns {{ key: string, label: string, tone: string }}
 */
export function queueRowLifecycle(queue) {
  if (queue === undefined) return lc('approved')
  if (queue === null) return lc('approved_not_queued')
  const billStatus = String(queue.xero_bill_status || '').toUpperCase()
  if (queue.xero_bill_paid_at || billStatus === 'PAID') return lc('paid')
  if (billStatus === 'VOIDED' || billStatus === 'DELETED') return lc('voided_in_xero')
  if (queue.status === 'forwarded' || queue.xero_bill_id || queue.forwarded_at) return lc('sent_to_xero')
  if (queue.status === 'rejected') return lc('rejected_by_accountant')
  return lc('queued_for_accountant')
}

/**
 * Newest queue row per source key (a retry may have enqueued twice).
 * Returns a Map<sourceId, row>.
 */
export function latestQueueRowBy(rows, sourceKey) {
  const map = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    const key = r?.[sourceKey]
    if (!key) continue
    const prev = map.get(key)
    if (!prev || String(r.created_at || '') > String(prev.created_at || '')) map.set(key, r)
  }
  return map
}

// When a claim's items disagree, the claim reads as its LEAST-advanced
// item — the claim is only "Sent to Xero" once every receipt is, and
// only "Paid" once every bill is. Problem states outrank progress so a
// rejected receipt is never hidden behind its siblings' good news.
const AGGREGATE_ORDER = [
  'rejected_by_accountant',
  'voided_in_xero',
  'approved_not_queued',
  'queued_for_accountant',
  'sent_to_xero',
  'paid',
]

const DETAIL_PHRASE = {
  rejected_by_accountant: 'rejected by accountant',
  voided_in_xero: 'voided in Xero',
  approved_not_queued: 'not yet queued',
  queued_for_accountant: 'queued for accountant',
  sent_to_xero: 'sent to Xero',
  paid: 'paid',
}

/**
 * Aggregate per-item lifecycles into one claim lifecycle.
 *
 * @param {Array<{key: string}>} itemLifecycles  queueRowLifecycle() per item
 * @returns {{ key, label, tone, detail: string|null, counts: object }}
 */
export function aggregateQueueLifecycles(itemLifecycles) {
  const list = Array.isArray(itemLifecycles) ? itemLifecycles : []
  const counts = {}
  for (const l of list) counts[l.key] = (counts[l.key] || 0) + 1
  const worst = AGGREGATE_ORDER.find((k) => counts[k]) || null
  if (!worst) return { ...lc('approved'), detail: null, counts }
  const keys = Object.keys(counts)
  const detail = keys.length > 1
    ? AGGREGATE_ORDER.filter((k) => counts[k])
        .map((k) => `${counts[k]} of ${list.length} ${DETAIL_PHRASE[k]}`)
        .join(', ')
    : null
  return { ...lc(worst), detail, counts }
}

const PRE_APPROVAL = {
  draft: { key: 'draft', label: 'Draft', tone: 'slate' },
  submitted: { key: 'submitted', label: 'Awaiting review', tone: 'amber' },
  declined: { key: 'declined', label: 'Declined', tone: 'red' },
  revoked: { key: 'revoked', label: 'Revoked', tone: 'slate' },
}

/**
 * Honest lifecycle label for an FTE expense claim.
 *
 * @param {object} claim  fte_expense_claims row (status, xero_synced_at)
 * @param {undefined | { itemIds: string[], rows: object[] }} queue
 *   undefined → not looked up / lookup FAILED → plain "Approved"
 *   object    → the claim's item ids and every invoices_queue row whose
 *               source_fte_expense_item_id is one of them
 * @returns {{ key, label, tone, detail: string|null }}
 */
export function expenseClaimLifecycle(claim, queue) {
  const status = claim?.status
  if (!status) return { ...PRE_APPROVAL.submitted, detail: null }
  if (PRE_APPROVAL[status]) return { ...PRE_APPROVAL[status], detail: null }

  if (status === 'approved') {
    // Pre-queue (before INVOICES-QUEUE.1) claims forwarded straight to
    // Xero by email and stamped xero_synced_at on the claim itself.
    return { ...lc(claim.xero_synced_at ? 'sent_to_xero' : 'approved'), detail: null }
  }

  if (status === 'awaiting_accountant_review') {
    if (queue === undefined || queue === null) return { ...lc('approved'), detail: null }
    const itemIds = Array.isArray(queue.itemIds) ? queue.itemIds.filter(Boolean) : []
    // A claim with no items enqueues nothing (enqueueFromFteExpenseClaim
    // returns ok with no rows), so "not queued" would be a false alarm.
    if (itemIds.length === 0) return { ...lc('approved'), detail: null }
    const byItem = latestQueueRowBy(queue.rows, 'source_fte_expense_item_id')
    const perItem = itemIds.map((id) => queueRowLifecycle(byItem.get(id) || null))
    const agg = aggregateQueueLifecycles(perItem)
    return { key: agg.key, label: agg.label, tone: agg.tone, detail: agg.detail }
  }

  return { key: String(status), label: String(status), tone: 'slate', detail: null }
}
