// POST /api/orders/[id]/refund
//
// Operator-initiated refund for a completed order. Manager+ at the
// order's location.
//
// Body (optional):
//   amount_cents?: number   // partial refund; omit for full
//   reason?: string         // free-text, stored on metadata.refund_reason
//
// Flow:
//   1. Resolve the order + verify caller has access
//   2. Reject if not status='completed' or an unsupported provider
//   3. Refund via the order's provider — Revolut (internal events/deposits)
//      or the host's Stripe connected account (third-party events). A FULL
//      refund also returns UN1T's per-ticket booking fee; a partial keeps it.
//   4. Update orders.status='refunded', set refunded_at +
//      refunded_amount_cents
//   5. Cascade to source row (race_payments / cars.deposit_status)
//   6. Emit ORDER_REFUNDED event + apply tag rules

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { RevolutError } from '@/lib/revolut'
import { paymentsFor } from '@/lib/payments'
import { emitEvent, applyTagRules, EVENT_TYPES } from '@/lib/contact-events'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  amount_cents: z.number().int().positive().optional(),
  reason: z.string().max(500).optional(),
})

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
  if (!hasPermission(user, 'orders')) {
    return NextResponse.json({ success: false, error: 'Orders feature is disabled at this location' }, { status: 403 })
  }
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
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

  // Partial vs full — delegates all guards to the pure resolveRefund helper.
  const resolution = resolveRefund(order, body.amount_cents)
  if (!resolution.ok) {
    return NextResponse.json({
      success: false,
      error: resolution.error,
      code: resolution.code,
    }, { status: resolution.status })
  }
  const refundAmount = resolution.refundAmount

  // Dispatch to the order's payment provider. Revolut → refundOrder (dedupes
  // internally); Stripe Connect → a refund on the host's connected account.
  // A FULL refund also returns UN1T's booking fee (refundApplicationFee) so the
  // customer is made whole; a PARTIAL refund keeps the fee and comes out of the
  // host's portion. Provider errors → a clean 502. (EVENTS-HOST.7)
  let refundResult = null
  try {
    refundResult = await paymentsFor(order.payment_provider).refundPayment(order.payment_provider_ref, {
      amountCents: refundAmount,
      currency: order.currency || 'EUR',
      description: body.reason || `Refund of order ${order.id}`,
      connectedAccountId: order.connected_account_id || null,
      refundApplicationFee: resolution.isFull,
      // Cumulative total is unique per refund step → retry-safe without
      // colliding two distinct partial refunds of the same amount.
      idempotencyKey: `refund:${order.id}:${resolution.newRefundedTotal}`,
    })
  } catch (e) {
    const status = e instanceof RevolutError ? Math.min(Math.max(e.status || 502, 400), 599) : 502
    return NextResponse.json({
      success: false,
      error: `Refund failed: ${e.message || 'unknown'}`,
      code: 'provider_error',
    }, { status })
  }

  // Update orders row. Partial refunds keep the order 'completed' (a valid
  // enum value) with the CUMULATIVE refunded_amount_cents recorded; only a
  // refund that clears the remaining balance flips it to 'refunded'.
  // (Previously every refund — partial included — was mislabelled 'refunded',
  // which both hid partials and blocked any legitimate top-up refund.)
  const nowIso = new Date().toISOString()
  const newStatus = resolution.isFull ? 'refunded' : order.status
  const updates = {
    status: newStatus,
    refunded_at: nowIso,
    refunded_amount_cents: resolution.newRefundedTotal,
    metadata: {
      ...(order.metadata || {}),
      refund_reason: body.reason || null,
      refund_actor_id: user.id,
      refund_provider: order.payment_provider,
      refund_provider_id: refundResult?.refundId || null,
      // Back-compat: readers that keyed on the Revolut-specific field.
      refund_revolut_id: order.payment_provider === 'revolut' ? (refundResult?.refundId || null) : null,
    },
  }
  await db.from('orders').update(updates).eq('id', order.id)

  // Cascade to source. Both target tables have their own status enum.
  if (order.source_type === 'race_registration') {
    await db.from('race_payments')
      .update({
        status: resolution.isFull ? 'refunded' : 'completed',
        refunded_at: nowIso,
        refunded_amount_cents: resolution.newRefundedTotal,
      })
      .eq('id', order.source_id)
  } else if (order.source_type === 'car_deposit' && resolution.isFull) {
    // Car deposits are fixed-amount; only a full refund clears the deposit.
    await db.from('cars')
      .update({ deposit_status: 'refunded' })
      .eq('id', order.source_id)
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
        reason: body.reason || null,
        actor_id: user.id,
      },
    })
    if (order.contact_id) {
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
