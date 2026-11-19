// POST /api/orders/[id]/refund
//
// Operator-initiated refund for a completed order. Owners and masters at
// the order's location, with a reason (REFUNDLEDGER.1, Richard's decision
// 19 Nov 2026).
//
// Body:
//   amount_cents?: number   // partial refund; omit for the whole remaining balance
//   reason: string          // required; stored on the refund row
//
// Flow (REFUNDLEDGER.1, mig 853):
//   1. Resolve the order + verify caller has access
//   2. Reject an unsupported provider (resolveRefund)
//   3. CLAIM the refund in the database (claim_order_refund): the order row is
//      locked and a 'requested' refund recorded before any money moves, so two
//      refunds can never be in flight on one order. The same amount asked again
//      resumes that refund with the same idempotency key.
//   4. Refund via the order's provider — Revolut (internal events/deposits)
//      or the host's Stripe connected account (third-party events). A FULL
//      refund also returns UN1T's per-ticket booking fee; a partial keeps it.
//   5. Record the answer (finish_order_refund): completed adds to the order's
//      total and flips it to 'refunded' when nothing is left; a refusal frees
//      the order; no answer keeps it held for a retry.
//   6. Cascade to source row (race_payments / cars.deposit_status)
//   7. Emit ORDER_REFUNDED event + apply tag rules

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { RevolutError } from '@/lib/revolut'
import { paymentsFor } from '@/lib/payments'
import { emitEvent, applyTagRules, EVENT_TYPES } from '@/lib/contact-events'
import { validateBody } from '@/lib/validate'
import { logError } from '@/lib/log'
import { GAP_PAYMENT_KIND } from '@/lib/registration-entry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  amount_cents: z.number().int().positive().optional(),
  reason: z.string().trim().min(1, 'Give a reason for the refund.').max(500),
})

// Who may refund: owners and masters at the order's studio (masters pass
// hasRoleAtLocation). REFUNDLEDGER.1 — managers could refund before.
const REFUND_ROLES = Object.freeze(['owner'])
const REFUND_ROLE_ERROR = 'Only owners and masters can refund an order.'

/**
 * REFUNDLEDGER.1 — did the provider definitely refuse, or might the refund
 * have gone through? Fails closed: only a 4xx answer (not 408 or 429) is a
 * definite refusal, from Revolut or Stripe. A timeout, a network error, a 5xx,
 * a Stripe connection or API error, or anything unrecognised might have paid
 * out, so the claim stays held and a retry reuses its idempotency key.
 */
export function refundOutcomeUnknown(e) {
  if (e instanceof RevolutError && (e.code === 'timeout' || e.code === 'network')) return true
  if (e?.type === 'StripeConnectionError' || e?.type === 'StripeAPIError') return true
  const status = Number(e?.status ?? e?.statusCode) || 0
  return !(status >= 400 && status < 500 && status !== 408 && status !== 429)
}

// claim_order_refund's refusals, in this route's words.
const CLAIM_REFUSALS = {
  not_found: () => ({ status: 404, error: 'Order not found' }),
  invalid_status: (r) => ({ status: 409, error: `Only completed orders can be refunded (current status: ${r.status}).` }),
  already_refunded: () => ({ status: 409, error: 'This order has already been fully refunded.' }),
  refund_exceeds_order: (r) => ({ status: 400, error: `That is more than the ${r.remaining_cents} cents left to refund on this order.` }),
  refund_in_progress: (r) => ({ status: 409, error: `Another refund of ${r.amount_cents} cents on this order has not finished. Retry that same amount to finish it before refunding a different amount.` }),
  refund_needs_check: (r) => ({ status: 409, error: `A refund of ${r.amount_cents} cents on this order was started over 20 hours ago and never confirmed. Check the payment provider to see whether it went through before refunding again; it cannot be retried from here.` }),
}

/**
 * Pure decision logic for whether an order can be refunded and what
 * amount to refund. Extracted so it can be unit-tested without an HTTP
 * request or DB round-trip.
 *
 * Returns { ok: true, refundAmount } or { ok: false, code, error, status }.
 */
export function resolveRefund(order, requestedAmountCents) {
  if (order.status !== 'completed') {
    return {
      ok: false,
      code: 'invalid_status',
      error: `Only completed orders can be refunded (current status: ${order.status}).`,
      status: 409,
    }
  }
  // Revolut (internal/UN1T events, deposits) and Stripe Connect (third-party
  // host events — refunded on the host's own connected account) are both
  // supported. Any other provider (e.g. legacy/free) still routes to a manual
  // refund. (EVENTS-HOST.7)
  if (!['revolut', 'stripe_connect'].includes(order.payment_provider)) {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Refunds are only supported for Revolut- or Stripe-paid orders. Issue a manual refund via your provider.',
      status: 400,
    }
  }
  if (order.payment_provider === 'stripe_connect' && !order.connected_account_id) {
    return {
      ok: false,
      code: 'no_connected_account',
      error: 'Stripe-paid order is missing the host connected account — cannot refund automatically.',
      status: 422,
    }
  }
  if (!order.payment_provider_ref) {
    return {
      ok: false,
      code: 'no_provider_ref',
      error: 'Order is missing a payment reference — cannot refund.',
      status: 422,
    }
  }
  // Refunds are cumulative: a partial refund leaves the order 'completed'
  // (see the handler), so guard against the REMAINING refundable balance,
  // not the gross total — otherwise a second partial refund could push the
  // total refunded past what was captured.
  const alreadyRefunded = Number(order.refunded_amount_cents) || 0
  const remaining = Number(order.amount_cents) - alreadyRefunded
  if (remaining <= 0) {
    return {
      ok: false,
      code: 'already_refunded',
      error: 'This order has already been fully refunded.',
      status: 409,
    }
  }
  if (requestedAmountCents && requestedAmountCents > remaining) {
    return {
      ok: false,
      code: 'refund_exceeds_order',
      error: `Refund amount (${requestedAmountCents}) exceeds the remaining refundable balance (${remaining}) on this ${order.amount_cents}-cent order.`,
      status: 400,
    }
  }
  const refundAmount = requestedAmountCents || remaining
  const newRefundedTotal = alreadyRefunded + refundAmount
  return {
    ok: true,
    refundAmount,
    newRefundedTotal,
    // True when this refund clears the remaining balance → order becomes 'refunded'.
    isFull: newRefundedTotal >= Number(order.amount_cents),
  }
}

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'orders')) {
    return NextResponse.json({ success: false, error: 'Orders feature is disabled at this location' }, { status: 403 })
  }
  if (!hasRoleAtAnyLocation(user, REFUND_ROLES)) {
    return NextResponse.json({ success: false, error: REFUND_ROLE_ERROR }, { status: 403 })
  }

  const validation = await validateBody(request, Body, { allowEmpty: true })
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: order, error: lookupErr } = await db
    .from('orders')
    .select('*')
    .eq('id', params.id)
    .single()
  if (lookupErr || !order) {
    return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 })
  }

  const guard = assertLocationAccessOr404(user, order.location_id)
  if (guard) return guard
  // ROLESWEEP.1b — judged at the order's location, not the caller's active studio.
  if (!hasPermissionForLocation(user, order.location_id, 'orders')) {
    return NextResponse.json({ success: false, error: 'Orders feature is disabled at this location' }, { status: 403 })
  }
  if (!hasRoleAtLocation(user, order.location_id, REFUND_ROLES)) {
    return NextResponse.json({ success: false, error: REFUND_ROLE_ERROR }, { status: 403 })
  }

  // Partial vs full — delegates all guards to the pure resolveRefund helper.
  const resolution = resolveRefund(order, body.amount_cents)
  if (!resolution.ok) {
    return NextResponse.json({
      success: false,
      error: resolution.error,
      code: resolution.code,
    }, { status: resolution.status })
  }

  // REFUNDLEDGER.1 — claim before any money moves. The order row is locked
  // inside the function, so a second refund cannot pass the same balance check.
  const { data: claim, error: claimErr } = await db.rpc('claim_order_refund', {
    p_order_id: order.id,
    p_amount_cents: body.amount_cents ?? null,
    p_reason: body.reason,
    p_actor_id: user.id,
  })
  if (claimErr || !claim) {
    logError('orders-refund', 'refund claim failed', { err: claimErr, orderId: order.id })
    return NextResponse.json({ success: false, error: 'Could not start the refund. Nothing was refunded. Try again.', code: 'claim_failed' }, { status: 503 })
  }
  if (!claim.ok) {
    const refusal = (CLAIM_REFUSALS[claim.code] || (() => ({ status: 409, error: 'This order cannot be refunded right now.' })))(claim)
    return NextResponse.json({ success: false, error: refusal.error, code: claim.code }, { status: refusal.status })
  }
  const refundAmount = claim.amount_cents
  const finish = (status, providerRefundId = null, error = null) => db.rpc('finish_order_refund', {
    p_refund_id: claim.refund_id, p_status: status, p_provider_refund_id: providerRefundId, p_error: error,
  })

  // Dispatch to the order's payment provider. Revolut → refundOrder, which
  // sends the idempotency key below as the Idempotency-Key header (REVPAY.1);
  // Stripe Connect → a refund on the host's connected account, same key.
  // The key is the claimed refund's own, so a resumed refund resends the
  // SAME key and the provider returns the refund it already made.
  // A FULL refund also returns UN1T's booking fee (refundApplicationFee) so the
  // customer is made whole; a PARTIAL refund keeps the fee and comes out of the
  // host's portion. Provider errors → a clean 502. (EVENTS-HOST.7)
  let refundResult = null
  try {
    refundResult = await paymentsFor(order.payment_provider).refundPayment(order.payment_provider_ref, {
      amountCents: refundAmount,
      currency: order.currency || 'EUR',
      description: body.reason,
      connectedAccountId: order.connected_account_id || null,
      refundApplicationFee: claim.is_full,
      idempotencyKey: claim.idempotency_key,
    })
  } catch (e) {
    const status = e instanceof RevolutError ? Math.min(Math.max(e.status || 502, 400), 599) : 502
    // REVPAY.1 — no answer (timeout / network) or a 5xx means the provider may
    // have refunded anyway. The claim stays held ('unknown'), so no other
    // amount can be refunded until this one is retried and answered. Only a
    // definite refusal releases it (refundOutcomeUnknown, for every provider).
    const outcomeUnknown = refundOutcomeUnknown(e)
    const { error: finishErr } = await finish(outcomeUnknown ? 'unknown' : 'failed', null, String(e?.message || 'provider error').slice(0, 500))
    if (finishErr) logError('orders-refund', 'refund outcome not recorded on the claim', { err: finishErr, orderId: order.id, refundId: claim.refund_id })
    if (outcomeUnknown) {
      logError('orders-refund', 'refund outcome unknown (no answer or 5xx from the provider)', { err: e, orderId: order.id, provider: order.payment_provider })
      return NextResponse.json({
        success: false,
        error: `The payment provider did not confirm this refund (${e.message || 'no answer'}). It may have gone through. Retry the SAME refund to check: it is idempotent and will not pay out twice.`,
        code: 'provider_outcome_unknown',
      }, { status })
    }
    return NextResponse.json({
      success: false,
      error: `Refund failed: ${e.message || 'unknown'}`,
      code: 'provider_error',
    }, { status })
  }

  // REFUNDLEDGER.1 — the money has gone back. Record it on the claim; the
  // function adds it to the order's total and status. If that write fails the
  // claim stays 'requested', so a retry of the same amount resumes it with the
  // same key and records it then. The cascade and events wait for that retry.
  const { data: finished, error: finishErr } = await finish('completed', refundResult?.refundId || null)
  if (finishErr || !finished?.ok) {
    logError('orders-refund', 'refund issued but NOT recorded', {
      err: finishErr, orderId: order.id, refundId: claim.refund_id, providerRefundId: refundResult?.refundId || null,
    })
    return NextResponse.json({
      success: false,
      error: 'The refund went through with the payment provider, but it could not be recorded here. Retry the SAME refund (same amount) to record it: it will not pay out twice.',
      code: 'refund_not_recorded',
      data: { order_id: order.id, refund_id: refundResult?.refundId || null },
    }, { status: 500 })
  }
  const nowIso = new Date().toISOString()
  const isFull = finished.is_full === true
  const refundedTotal = Number(finished.refunded_total_cents) || 0

  // Cascade to source. Both target tables have their own status enum.
  // EVENT-MOVE.5 — the write answers the payment's kind: a refunded price
  // difference (move_gap) skips tag rules below, which are written for entry
  // payments. It never un-settles the move (staff decide).
  let sourceKind = null
  if (order.source_type === 'race_registration') {
    const { data: srcRows, error: srcErr } = await db.from('race_payments')
      .update({
        status: isFull ? 'refunded' : 'completed',
        refunded_at: nowIso,
        refunded_amount_cents: refundedTotal,
      })
      .eq('id', order.source_id)
      .select('kind')
    if (srcErr) {
      // The money has gone back; the source row did not follow. Logged so it
      // can be put right; tag rules then run as they always did.
      logError('orders-refund', 'refund issued but race_payments was NOT updated', { err: srcErr, orderId: order.id, paymentId: order.source_id })
    } else {
      sourceKind = srcRows?.[0]?.kind || null
    }
  } else if (order.source_type === 'car_deposit' && isFull) {
    // Car deposits are fixed-amount; only a full refund clears the deposit.
    // The order row already says refunded, so a failed write is logged to be
    // put right by hand (the same posture as race_payments above).
    const { error: carErr } = await db.from('cars')
      .update({ deposit_status: 'refunded' })
      .eq('id', order.source_id)
    if (carErr) {
      logError('orders-refund', 'refund issued but cars.deposit_status was NOT updated', { err: carErr, orderId: order.id, carId: order.source_id })
    }
  }

  // Event + tag re-evaluation. Best-effort — refund is already
  // committed to Revolut + DB.
  try {
    await emitEvent({
      db,
      eventType: EVENT_TYPES.ORDER_REFUNDED,
      contactEmail: order.contact_email,
      contactId: order.contact_id || null,
      locationId: order.location_id,
      sourceType: order.source_type,
      sourceId: order.source_id,
      metadata: {
        amount_cents: refundAmount,
        currency: order.currency,
        reason: body.reason,
        actor_id: user.id,
      },
    })
    if (order.contact_id && sourceKind !== GAP_PAYMENT_KIND) {
      await applyTagRules({ db, contactId: order.contact_id })
    }
  } catch (e) {
    console.warn(`[orders-refund] event/tag sync failed for order ${order.id}: ${e?.message || e}`)
  }

  return NextResponse.json({
    success: true,
    data: {
      order_id: order.id,
      refunded_amount_cents: refundAmount,
      refunded_at: nowIso,
      refund_id: refundResult?.refundId || null,
      // Back-compat alias — same value; populated for Revolut as before.
      revolut_refund_id: order.payment_provider === 'revolut' ? (refundResult?.refundId || null) : null,
    },
  })
}
