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
