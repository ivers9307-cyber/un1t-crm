// Car deposit ← Revolut order state (REVPAY.3).
//
// The one place a car's deposit is moved by a Revolut order's authoritative
// state, with its side effects. Two callers, one behaviour:
//   - the signed webhook (/api/webhooks/revolut), on every delivery;
//   - the reconcile cron (/api/cron/revolut-reconcile), for a deposit whose
//     webhook never landed.
// Moved out of the webhook route so a cron never imports a route file; the
// route re-exports depositUpdateForOrder so its tests still find it there.

import { syncOrderFromCarDeposit } from './orders'
import { emitEvent, EVENT_TYPES } from './contact-events'
import { triggerSequencesForOrderStatus } from './sequences'
import { escapeLikePattern } from './like-escape'
import { orgLocationIdsFor, scopeFor } from './inbound-contact-match'
import { pickContact } from './email-inbox'
import { logInfo, logError } from './log'

// REVOLUT.1 — buyer_email, deposit_revolut_order_id and deposit_link_sent_at
// are read by the orders sync and the buyer-contact branch below.
// buyer_email was missing from the webhook's select until REVOLUT.1, so both
// were dead in production (syncOrderFromCarDeposit returns null without it,
// and the `car.buyer_email` guard never passed).
export const CAR_DEPOSIT_SELECT = `
      id, location_id, deposit_token, deposit_status, deposit_paid_at,
      deposit_amount, deposit_paid_amount,
      deposit_revolut_order_id, deposit_link_sent_at,
      buyer_email, buyer_phone, buyer_name, make, model, irish_reg,
      locations ( id, name )
    `

/**
 * Pure: map a freshly-fetched Revolut order's state onto the cars-deposit
 * column updates. Terminal states (completed / cancelled / failed) return an
 * `updates` object; transient states (pending / processing / authorised)
 * return `updates: null` so the caller skips without a write.
 *
 * IDEMPOTENCY CROWN-JEWEL: a re-delivered ORDER_COMPLETED must NEVER re-stamp
 * `deposit_paid_at` — the `!car.deposit_paid_at` guard means the first
 * completion wins and retries leave the original timestamp intact. Revolut
 * amounts are minor units; converted back to majors here.
 *
 * Order states per Revolut Merchant API spec (merchant-2026-03-12.yaml,
 * schema Order-State): pending, processing, authorised, completed,
 * cancelled, failed. There is NO 'refunded' order state: a refund is a NEW
 * order with type=refund linked via related_order_id, and the original
 * order stays 'completed'.
 *
 * @param {{ order: {state?: string, amount?: number}, car: {deposit_paid_at?: string|null}, now?: Date }} args
 * @returns {{ state: string, updates: object|null }}
 */
export function depositUpdateForOrder({ order, car, now = new Date() }) {
  const state = String(order?.state || '').toLowerCase()
  const updates = {}
  switch (state) {
    case 'completed':
      updates.deposit_status = 'paid'
      if (!car?.deposit_paid_at) updates.deposit_paid_at = now.toISOString()
      if (Number.isFinite(order?.amount)) updates.deposit_paid_amount = Number(order.amount) / 100
      return { state, updates }
    case 'cancelled':
      updates.deposit_status = 'cancelled'
      return { state, updates }
    case 'failed':
      updates.deposit_status = 'failed'
      return { state, updates }
    default:
      return { state, updates: null }
  }
}

/**
 * Write a terminal deposit update and run its side effects: the orders
 * ledger, the contact_events row and the order_* sequence trigger.
 *
 * `guardStatus` (the cron passes true) makes the write a compare-and-set on
 * the deposit_status the caller read, and runs the side effects only when
 * THIS call's write landed: the webhook may settle the same car between the
 * cron's read and its write, and only one of them may emit the event and
 * enrol the buyer. The webhook path keeps its historical behaviour (plain
 * write, side effects on every terminal delivery the dedupe lets through).
 *
 * A failed deposit write returns `{ written: false, error }` and runs no side
 * effect (the row stays as it was, so the cron's next tick retries it). Side
 * effect failures are logged, never thrown: the deposit write is committed.
 *
 * @returns {Promise<{ written: boolean, error?: object }>}
 */
export async function applyCarDepositUpdates({ db, car, order, state, updates, guardStatus = false }) {
  if (!updates) return { written: false }
  if (Object.keys(updates).length > 0) {
    if (guardStatus) {
      let q = db.from('cars').update(updates).eq('id', car.id)
      q = car.deposit_status == null ? q.is('deposit_status', null) : q.eq('deposit_status', car.deposit_status)
      const { data, error } = await q.select('id')
      if (error) {
        logError('car-deposit-revolut', 'deposit write failed; nothing applied', { err: error, carId: car.id, state })
        return { written: false, error }
      }
      if (!Array.isArray(data) || data.length === 0) return { written: false }
    } else {
      const { error } = await db.from('cars').update(updates).eq('id', car.id)
      if (error) {
        logError('car-deposit-revolut', 'deposit write failed; nothing applied', { err: error, carId: car.id, state })
        return { written: false, error }
      }
    }
  }

  // Project the cars deposit state into the generic orders ledger and emit a
  // contact_events row for the matching transition. Best-effort: orders/events
  // failures must not affect the deposit write.
  try {
    const carForOrders = { ...car, ...updates }
    await syncOrderFromCarDeposit({ db, car: carForOrders })
    const evMap = {
      completed: EVENT_TYPES.ORDER_COMPLETED,
      failed: EVENT_TYPES.ORDER_FAILED,
      cancelled: EVENT_TYPES.ORDER_ABANDONED,
    }
    const evType = evMap[state]
    const buyerEmail = String(car.buyer_email || '').toLowerCase().trim()
    if (evType && !buyerEmail) {
      // No buyer email on the car: nothing to match a contact on, so no
      // event and no order_* enrolment. The deposit write above stands.
      logInfo('revolut-webhook', 'buyer contact skipped: no buyer_email', { carId: car.id, state })
    }
    if (evType && buyerEmail) {
      // Look up a contact by buyer_email so the order_* sequence trigger
      // (Tier 1A) has someone to enrol. We don't auto-create contacts on the
      // cars side — the cars deposit flow is for car buyers, not necessarily
      // UN1T contacts.
      // escapeLikePattern: buyer_email is typed into the public deposit form,
      // so a '%' or '_' in it would resolve to some unrelated contact and
      // enrol THEM in the order_* sequence.
      //
      // W0.6b — scoped to the CAR'S ORGANISATION (cars.location_id is NOT
      // NULL, mig 025, so there is always a scope; a failed sibling read
      // narrows to the car's own studio). contacts_email_org_unique (mig 712)
      // is per organisation, so one address can be a contact at several
      // tenants: the estate-wide `.maybeSingle()` enrolled ANOTHER tenant's
      // person in this tenant's order_* sequence when they were the only
      // holder, and enrolled nobody (PGRST116 read as "no contact") when
      // there were two. pickContact prefers the car's studio, then the
      // oldest row, then the lowest id — the same choice the mail webhook
      // makes. The error is logged, never discarded: no match is "no
      // enrolment", which the caller already tolerates.
      const orgLocIds = await orgLocationIdsFor(db, car.location_id)
      const { data: holders, error: holdersErr } = await db
        .from('contacts')
        .select('id, location_id, created_at')
        .in('location_id', scopeFor(orgLocIds))
        .ilike('email', escapeLikePattern(buyerEmail))
        .limit(20)
      if (holdersErr) {
        console.warn(`[revolut-webhook] buyer contact lookup failed for car ${car.id}: ${holdersErr.message}`)
      }
      const buyerContactId = pickContact(holders || [], car.location_id)?.id || null

      await emitEvent({
        db,
        eventType: evType,
        contactEmail: car.buyer_email,
        contactId: buyerContactId,
        locationId: car.location_id,
        sourceType: 'car_deposit',
        sourceId: car.id,
        metadata: {
          amount_cents: Number.isFinite(order?.amount) ? order.amount : null,
          car_make: car.make,
          car_model: car.model,
          irish_reg: car.irish_reg,
        },
      })

      // Sequence trigger fires only when we have a contact — the sequence
      // runner needs a contact_id to enrol. Cars-only buyers without a CRM
      // contact silently skip (acceptable for v1).
      if (buyerContactId && ['completed', 'failed', 'cancelled'].includes(state)) {
        const status = state === 'cancelled' ? 'abandoned' : state
        await triggerSequencesForOrderStatus({
          contactId: buyerContactId,
          locationId: car.location_id,
          status,
          sourceType: 'car_deposit',
          orderId: car.id,
        })
      }
    }
  } catch (e) {
    console.warn(`[revolut-webhook] orders/events sync failed for car ${car.id}: ${e?.message || e}`)
  }

  return { written: true }
}


// ── DEPOSITREISSUE.1 (mig 845) — orders a re-issued link superseded ─────────

/** Revolut states in which a buyer's payment is under way or done. */
const IN_FLIGHT = new Set(['processing', 'authorised'])

/**
 * Before a deposit link is re-issued over an unpaid order: decide what the
 * old order means. Pure.
 * @returns {'rotate'|'record_then_rotate'|'paid'|'in_flight'}
 */
export function reissueDecision(orderState) {
  const state = String(orderState || '').toLowerCase()
  if (state === 'completed') return 'paid'
  if (IN_FLIGHT.has(state)) return 'in_flight'
  if (state === 'pending') return 'record_then_rotate'
  return 'rotate' // cancelled, failed: nothing can be paid on it any more
}

/**
 * Settle an order a re-issue superseded. A COMPLETED order marks the car paid
 * (and becomes its order of record); cancelled/failed closes the row and
 * leaves the car alone (its new link is live); anything else is still open.
 * A completed old order on a car ALREADY paid by its new link is a double
 * payment: logged at error for a person to refund, the row closed.
 *
 * An old order that paid less than the car's current deposit (or not in euro)
 * is closed as `amount_mismatch` and logged; it never marks the car paid.
 *
 * @returns {Promise<{ outcome: 'not_superseded'|'still_pending'|'settled'|'closed'|'double_payment'|'amount_mismatch'|'not_applied'|'error', state?: string, error?: any }>}
 */
export async function settleSupersededOrder({ db, orderId, getOrder }) {
  const { data: row, error: rowErr } = await db.from('car_deposit_superseded_orders')
    .select('order_id, car_id, settled_at').eq('order_id', orderId).maybeSingle()
  if (rowErr) return { outcome: 'error', error: rowErr }
  if (!row) return { outcome: 'not_superseded' }
  if (row.settled_at) return { outcome: 'closed' }

  const order = await getOrder(orderId)
  if (!order) return { outcome: 'error', error: new Error('order not readable') }
  const state = String(order.state || '').toLowerCase()
  const close = async (settledState) => {
    const { error } = await db.from('car_deposit_superseded_orders')
      .update({ settled_at: new Date().toISOString(), settled_state: settledState })
      .eq('order_id', orderId).is('settled_at', null)
    if (error) logError('car-deposit-revolut', 'superseded order settled but not recorded; it is re-checked', { orderId, err: error })
  }

  if (state === 'cancelled' || state === 'failed') {
    await close(state)
    return { outcome: 'closed', state }
  }
  if (state !== 'completed') return { outcome: 'still_pending', state }

  const { data: car, error: carErr } = await db.from('cars').select(`
      id, location_id, deposit_token, deposit_status, deposit_paid_at,
      deposit_amount, deposit_paid_amount,
      deposit_revolut_order_id, deposit_link_sent_at,
      buyer_email, buyer_phone, buyer_name, make, model, irish_reg,
      locations ( id, name )
    `).eq('id', row.car_id).maybeSingle()
  if (carErr) return { outcome: 'error', error: carErr }
  if (!car) { await close('car_gone'); return { outcome: 'closed', state } }
  if (car.deposit_status === 'paid' && car.deposit_revolut_order_id !== orderId) {
    logError('car-deposit-revolut', 'DOUBLE PAYMENT: a superseded deposit order completed on a car already paid; refund one by hand', {
      carId: car.id, orderId, carOrderId: car.deposit_revolut_order_id,
    })
    await close('double_payment')
    return { outcome: 'double_payment', state }
  }
  // The old order was for the deposit as it stood then. It counts as the
  // deposit only if it covers the car's CURRENT deposit, in euro: a re-issue
  // can raise the amount, and an underpaid old order must not mark it paid.
  const paidMinor = Number(order.amount)
  const dueMinor = Math.round(Number(car.deposit_amount) * 100)
  const currency = String(order.currency || 'EUR').toUpperCase()
  if (currency !== 'EUR' || !Number.isFinite(paidMinor) || (Number.isFinite(dueMinor) && paidMinor < dueMinor)) {
    logError('car-deposit-revolut', 'superseded deposit order paid a different amount than the current deposit; car not marked paid, review by hand', {
      carId: car.id, orderId, paidMinor: Number.isFinite(paidMinor) ? paidMinor : null, dueMinor: Number.isFinite(dueMinor) ? dueMinor : null, currency,
    })
    await close('amount_mismatch')
    return { outcome: 'amount_mismatch', state }
  }

  // The car's CURRENT order (its new link) must stay tracked: it becomes a
  // superseded order itself, so a later payment on it raises the
  // double-payment alert instead of vanishing.
  if (car.deposit_revolut_order_id && car.deposit_revolut_order_id !== orderId) {
    const { error: keepErr } = await db.from('car_deposit_superseded_orders').upsert({
      order_id: car.deposit_revolut_order_id, car_id: car.id, location_id: car.location_id,
    }, { onConflict: 'order_id', ignoreDuplicates: true })
    if (keepErr) return { outcome: 'error', error: keepErr }
  }

  const { updates } = depositUpdateForOrder({ order, car })
  const { written, error } = await applyCarDepositUpdates({
    db, car, order, state, updates: { ...updates, deposit_revolut_order_id: orderId }, guardStatus: true,
  })
  if (error) return { outcome: 'error', error }
  if (!written) return { outcome: 'not_applied', state }
  await close('completed')
  return { outcome: 'settled', state }
}
