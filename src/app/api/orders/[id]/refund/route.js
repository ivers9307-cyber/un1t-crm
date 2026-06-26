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
//   2. Reject if not status='completed' or non-revolut provider
//   3. Call refundOrder() against Revolut (idempotent — Revolut
//      itself dedupes on the same idempotency key)
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
import { refundOrder, RevolutError } from '@/lib/revolut'
import { emitEvent, applyTagRules, EVENT_TYPES } from '@/lib/contact-events'

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
  if (order.payment_provider !== 'revolut') {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Refunds are only supported for Revolut-paid orders. Issue a manual refund via your provider.',
      status: 400,
    }
  }
  if (!order.payment_provider_ref) {
    return {
      ok: false,
      code: 'no_provider_ref',
      error: 'Order is missing a Revolut order reference — cannot refund.',
      status: 422,
    }
  }
  if (requestedAmountCents && requestedAmountCents > order.amount_cents) {
    return {
      ok: false,
      code: 'refund_exceeds_order',
      error: `Refund amount (${requestedAmountCents}) exceeds order total (${order.amount_cents}).`,
      status: 400,
    }
  }
  return { ok: true, refundAmount: requestedAmountCents || order.amount_cents }
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

  const raw = await request.json().catch(() => ({}))
  const parsed = Body.safeParse(raw || {})
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: 'Invalid request body',
      details: parsed.error.flatten(),
    }, { status: 400 })
  }
  const body = parsed.data

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

  // Hit Revolut. RevolutError → surface a clean 502.
  let revolutResult = null
  try {
    revolutResult = await refundOrder(order.payment_provider_ref, {
      amount: refundAmount,
      currency: order.currency || 'EUR',
      description: body.reason || `Refund of order ${order.id}`,
    })
  } catch (e) {
    const status = e instanceof RevolutError ? Math.min(Math.max(e.status || 502, 400), 599) : 502
    return NextResponse.json({
      success: false,
      error: `Revolut refund failed: ${e.message || 'unknown'}`,
      code: 'provider_error',
    }, { status })
  }

  // Update orders row.
  const nowIso = new Date().toISOString()
  const newStatus = refundAmount === order.amount_cents ? 'refunded' : 'refunded' // partial still 'refunded' for v1
  const updates = {
    status: newStatus,
    refunded_at: nowIso,
    refunded_amount_cents: refundAmount,
    metadata: {
      ...(order.metadata || {}),
      refund_reason: body.reason || null,
      refund_actor_id: user.id,
      refund_revolut_id: revolutResult?.id || null,
    },
  }
  await db.from('orders').update(updates).eq('id', order.id)

  // Cascade to source. Both target tables have their own status enum.
  if (order.source_type === 'race_registration') {
    await db.from('race_payments')
      .update({ status: 'refunded', refunded_at: nowIso, refunded_amount_cents: refundAmount })
      .eq('id', order.source_id)
  } else if (order.source_type === 'car_deposit') {
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
      revolut_refund_id: revolutResult?.id || null,
    },
  })
}
