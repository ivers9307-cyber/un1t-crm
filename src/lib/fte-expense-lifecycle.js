// EXPENSELIFE.1 — server-side loader behind the honest expense-claim
// lifecycle label (shared/accountant-queue-lifecycle.js).
//
// Owner approval flips fte_expense_claims.status to
// 'awaiting_accountant_review' and enqueues ONE invoices_queue row PER
// ITEM (enqueueFromFteExpenseClaim → source_fte_expense_item_id). The
// claim row never moves again; progress lives on those queue rows. This
// file fetches them. Kept apart from fte-expenses.js because that module
// is imported by a client component and this one talks to the DB.

import { logWarn } from './log.js'
import { expenseClaimLifecycle } from '@shared/accountant-queue-lifecycle'

const CHUNK = 100
const PAGE = 1000

/**
 * Look up the queue rows for every awaiting-accountant claim in `claims`.
 *
 * Returns `(claimId) => undefined | { itemIds, rows }`:
 *   undefined        → not looked up (other status) or a read FAILED —
 *                      the label falls back to plain "Approved"
 *   { itemIds, rows } → the claim's item ids + their queue rows
 *
 * Scoped by location_id as well as the source FK: service-role reads get
 * no RLS, and every queue row carries its claim's location.
 */
export async function loadQueueRowsForExpenseClaims(db, claims) {
  const awaiting = (Array.isArray(claims) ? claims : [])
    .filter((c) => c && c.id && c.status === 'awaiting_accountant_review')
  if (awaiting.length === 0) return () => undefined

  const claimIds = awaiting.map((c) => c.id)
  const locationIds = [...new Set(awaiting.map((c) => c.location_id).filter(Boolean))]
  const looked = new Set(claimIds)
  const itemsByClaim = new Map(claimIds.map((id) => [id, []]))
  const claimOfItem = new Map()

  // 1. Items per claim. Paginated: a page of claims can own >1000 items.
  for (let i = 0; i < claimIds.length; i += CHUNK) {
    const slice = claimIds.slice(i, i + CHUNK)
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('fte_expense_items')
        .select('id, claim_id')
        .in('claim_id', slice)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) {
        logWarn('fte-expense-lifecycle', 'item lookup failed', { err: error, count: slice.length })
        for (const id of slice) looked.delete(id)
        break
      }
      for (const it of data || []) {
        if (!itemsByClaim.has(it.claim_id)) continue
        itemsByClaim.get(it.claim_id).push(it.id)
        claimOfItem.set(it.id, it.claim_id)
      }
      if (!data || data.length < PAGE) break
    }
  }

  // 2. Queue rows for those items.
  const itemIds = [...claimOfItem.keys()].filter((id) => looked.has(claimOfItem.get(id)))
  const rowsByClaim = new Map()
  for (let i = 0; i < itemIds.length; i += CHUNK) {
    const slice = itemIds.slice(i, i + CHUNK)
    const { data, error } = await db
      .from('invoices_queue')
      .select('id, source_fte_expense_item_id, status, forwarded_at, xero_bill_id, xero_bill_status, xero_bill_paid_at, created_at')
      .in('location_id', locationIds)
      .in('source_fte_expense_item_id', slice)
    if (error) {
      logWarn('fte-expense-lifecycle', 'queue lookup failed', { err: error, count: slice.length })
      for (const itemId of slice) looked.delete(claimOfItem.get(itemId))
      continue
    }
    for (const r of data || []) {
      const claimId = claimOfItem.get(r.source_fte_expense_item_id)
      if (!claimId) continue
      if (!rowsByClaim.has(claimId)) rowsByClaim.set(claimId, [])
      rowsByClaim.get(claimId).push(r)
    }
  }

  return (claimId) => {
    if (!looked.has(claimId)) return undefined
    return { itemIds: itemsByClaim.get(claimId) || [], rows: rowsByClaim.get(claimId) || [] }
  }
}

/**
 * Attach `lifecycle` to each claim. Never throws: a loader failure
 * degrades every awaiting claim to plain "Approved".
 */
export async function withExpenseLifecycle(db, claims) {
  const list = Array.isArray(claims) ? claims : []
  let queueFor = () => undefined
  try {
    queueFor = await loadQueueRowsForExpenseClaims(db, list)
  } catch (e) {
    logWarn('fte-expense-lifecycle', 'lifecycle load threw', { err: e, count: list.length })
  }
  return list.map((c) => ({ ...c, lifecycle: expenseClaimLifecycle(c, queueFor(c.id)) }))
}
