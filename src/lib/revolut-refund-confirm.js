// REFUNDCONFIRM.1 — Orders PR 4 of the step 4 design: Revolut refunds are
// confirmed from Revolut's own record, by the revolut-reconcile cron.
//
// Revolut sends no refund webhook (no ORDER_REFUNDED event exists in the
// merchant API) and an order does not list its refunds. What it does give,
// on the ORIGINAL payment order, is `refunded_amount`: everything refunded
// from it, in minor units. Two checks use it.
//
// 1. A HELD refund — the ledger row (order_refunds, mig 853) is 'requested'
//    or 'unknown' because the refund route never heard Revolut's answer, or
//    heard it but could not record it. If Revolut's refunded_amount now
//    covers the ledger's completed refunds PLUS this one, the money went back:
//    the row is finished 'completed' (finish_order_refund, idempotent) and the
//    source row follows (applyRefundToSource). If it does not, the row is
//    left held: a refund can take up to two days to settle, and releasing it
//    would let staff refund again under a NEW key and pay out twice. A held
//    row older than 20 hours already refuses a retry (refund_needs_check);
//    this is what settles it without a person.
//
// 2. A DECLINED refund — a refund recorded 'completed' whose refund order
//    Revolut has since failed or cancelled. The customer did not get the
//    money but the CRM says they did. That is never undone automatically
//    (staff decide whether to refund again); it is recorded once, on the
//    refund row's `error`, and logged loudly so it reaches a person.
//
// Both run inside the reconcile tick with their own small budget and never
// make the tick unhealthy: they are counted (refund_*), like the receipt
// sweep. Rows younger than 10 minutes are skipped so the check cannot race
// the refund route's own call.
import { logError, logWarn } from '@/lib/log'
import { applyRefundToSource } from '@/lib/order-refund-cascade'

const LOG = 'revolut-refund-confirm'

export const REFUND_CONFIRM_MIN_AGE_MS = 10 * 60_000
export const REFUND_CONFIRM_MAX_AGE_MS = 14 * 24 * 60 * 60_000
export const REFUND_DECLINE_WINDOW_MS = 3 * 24 * 60 * 60_000
export const REFUND_CONFIRM_BUDGET = 20

const DECLINED_STATES = new Set(['failed', 'cancelled'])
export const DECLINED_MARKER = 'revolut_declined'

/**
 * Pure decision: does Revolut's refunded total prove this held refund
 * went through?
 * @param {{ revolutRefundedCents: number|null, completedCents: number, heldCents: number }} a
 * @returns {'confirmed'|'unconfirmed'|'unknown'}
 */
export function judgeHeldRefund({ revolutRefundedCents, completedCents, heldCents }) {
  if (!Number.isFinite(revolutRefundedCents)) return 'unknown'
  return revolutRefundedCents >= completedCents + heldCents ? 'confirmed' : 'unconfirmed'
}

const bump = (counts, key) => { counts[key] = (counts[key] || 0) + 1 }

async function completedCentsFor(db, orderId, orderRefundedCents) {
  const { data, error } = await db.from('order_refunds')
    .select('amount_cents')
    .eq('order_id', orderId)
    .eq('status', 'completed')
    .limit(200) // one order holds a handful of refunds at most
  if (error) throw error
  const sum = (data || []).reduce((s, r) => s + (Number(r.amount_cents) || 0), 0)
  // The same rule as claim_order_refund: a refund made outside the ledger
  // (the provider's dashboard) and synced onto the order counts too.
  return Math.max(sum, Number(orderRefundedCents) || 0)
}

async function confirmHeld({ db, getOrder, nowMs, counts, budget, pastDeadline }) {
  const { data: rows, error } = await db.from('order_refunds')
    .select('id, order_id, amount_cents, status, created_at, order:orders!order_id ( id, source_type, source_id, payment_provider, payment_provider_ref, amount_cents, refunded_amount_cents )')
    .eq('provider', 'revolut')
    .in('status', ['requested', 'unknown'])
    .gte('created_at', new Date(nowMs - REFUND_CONFIRM_MAX_AGE_MS).toISOString())
    .lte('created_at', new Date(nowMs - REFUND_CONFIRM_MIN_AGE_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(budget)
  if (error) {
    bump(counts, 'refund_list_failed')
    logError(LOG, 'held refunds unreadable', { code: error.code ?? null })
    return
  }
  for (const row of rows || []) {
    if (pastDeadline()) { bump(counts, 'refund_out_of_time'); continue }
    const order = row.order
    if (!order?.payment_provider_ref || order.payment_provider !== 'revolut') { bump(counts, 'refund_skipped'); continue }
    counts.refund_checked = (counts.refund_checked || 0) + 1
    let remote
    try {
      remote = await getOrder(order.payment_provider_ref)
    } catch (e) {
      bump(counts, 'refund_provider_failed')
      logWarn(LOG, 'Revolut order unreadable; held refund waits', { status: e?.status ?? null, errClass: e?.name ?? null })
      continue
    }
    try {
      const completedCents = await completedCentsFor(db, order.id, order.refunded_amount_cents)
      const verdict = judgeHeldRefund({
        revolutRefundedCents: Number.isFinite(remote?.refunded_amount) ? remote.refunded_amount : null,
        completedCents,
        heldCents: Number(row.amount_cents) || 0,
      })
      if (verdict !== 'confirmed') { bump(counts, verdict === 'unknown' ? 'refund_unknown' : 'refund_unconfirmed'); continue }
      const { data: finished, error: finishErr } = await db.rpc('finish_order_refund', {
        p_refund_id: row.id, p_status: 'completed', p_provider_refund_id: null, p_error: null,
      })
      if (finishErr || !finished?.ok) {
        bump(counts, 'refund_errors')
        logError(LOG, 'confirmed refund could not be recorded', { err: finishErr, refundId: row.id, orderId: order.id })
        continue
      }
      await applyRefundToSource(db, order, {
        isFull: finished.is_full === true,
        refundedTotal: Number(finished.refunded_total_cents) || 0,
      })
      bump(counts, 'refund_confirmed')
    } catch (e) {
      bump(counts, 'refund_errors')
      logError(LOG, 'held refund check failed', { err: e, refundId: row.id })
    }
  }
}

async function flagDeclined({ db, getOrder, nowMs, counts, budget, pastDeadline }) {
  const { data: rows, error } = await db.from('order_refunds')
    .select('id, order_id, provider_refund_id, location_id')
    .eq('provider', 'revolut')
    .eq('status', 'completed')
    .is('error', null)
    .not('provider_refund_id', 'is', null)
    .gte('finished_at', new Date(nowMs - REFUND_DECLINE_WINDOW_MS).toISOString())
    .lte('finished_at', new Date(nowMs - REFUND_CONFIRM_MIN_AGE_MS).toISOString())
    .order('finished_at', { ascending: true })
    .limit(budget)
  if (error) {
    bump(counts, 'refund_list_failed')
    logError(LOG, 'completed refunds unreadable', { code: error.code ?? null })
    return
  }
  for (const row of rows || []) {
    if (pastDeadline()) { bump(counts, 'refund_out_of_time'); continue }
    let refundOrder
    try {
      refundOrder = await getOrder(row.provider_refund_id)
    } catch (e) {
      bump(counts, 'refund_provider_failed')
      logWarn(LOG, 'Revolut refund order unreadable', { status: e?.status ?? null, errClass: e?.name ?? null })
      continue
    }
    const state = String(refundOrder?.state || '').toLowerCase()
    if (!DECLINED_STATES.has(state)) { bump(counts, 'refund_settled_ok'); continue }
    // Recorded once: the `error IS NULL` guard means a second tick writes
    // nothing and logs nothing.
    const { data: marked, error: markErr } = await db.from('order_refunds')
      .update({ error: `${DECLINED_MARKER}: Revolut ${state} this refund after it was recorded; the customer was not refunded` })
      .eq('id', row.id)
      .is('error', null)
      .select('id')
    if (markErr) { bump(counts, 'refund_errors'); logError(LOG, 'declined refund could not be marked', { err: markErr, refundId: row.id }); continue }
    if ((marked || []).length === 0) continue
    bump(counts, 'refund_declined')
    logError(LOG, 'Revolut declined a refund the CRM recorded as done; the customer was not refunded', {
      refundId: row.id, orderId: row.order_id, locationId: row.location_id, state,
    })
  }
}

/**
 * Run both checks. Never throws; counts go on `counts`.
 * @param {{ db: object, getOrder: (id: string) => Promise<object>, nowMs: number, counts: object, budget?: number, pastDeadline?: () => boolean }} args
 */
export async function sweepRevolutRefunds({ db, getOrder, nowMs, counts, budget = REFUND_CONFIRM_BUDGET, pastDeadline = () => false }) {
  try { await confirmHeld({ db, getOrder, nowMs, counts, budget, pastDeadline }) } catch (e) {
    bump(counts, 'refund_errors'); logError(LOG, 'held refund check threw', { err: e })
  }
  try { await flagDeclined({ db, getOrder, nowMs, counts, budget, pastDeadline }) } catch (e) {
    bump(counts, 'refund_errors'); logError(LOG, 'declined refund check threw', { err: e })
  }
}
