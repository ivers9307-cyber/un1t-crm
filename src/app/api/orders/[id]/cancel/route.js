// POST /api/orders/[id]/cancel
//
// Operator dismissal of a PENDING order (ORDERS-CANCEL.1, mig 268).
// Manager+ at the order's location, `orders` permission.
//
// The use case: a buyer with several pending payment attempts who in
// fact already holds a confirmed (completed) spot — the operator wants
// to clear the pending clutter. Sets orders.status='cancelled' and
// cascades the source row to its own terminal state. Deliberately does
// NOT emit an order.abandoned contact_event, so clearing a confirmed
// buyer's duplicate never trips the race_registered_no_payment
// retargeting tag (the refund route emits events; cancel is pure
// housekeeping and must stay invisible to the tag engine).
//
// Body (optional):
//   reason?: string   // free-text, stored on metadata.cancel_reason
//
// Guards: only status='pending' may be cancelled (409 otherwise).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { withAuth } from '@/lib/with-auth'
import { logError, logWarn } from '@/lib/log'
import { MANAGER_ROLES } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  reason: z.string().max(500).optional(),
})

// withAuth only signs the caller in; orders and Manager+ somewhere, the body,
// the order's studio (404), orders and Manager+ there and the pending-only 409
// stay by hand, in their old order. The writes are unchanged.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  if (!hasPermissionAtAnyLocation(user, 'orders')) {
    return NextResponse.json({ success: false, error: 'Orders feature is disabled at this location' }, { status: 403 })
  }
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const validation = await validateBody(request, Body, { allowEmpty: true })
  if (!validation.ok) return validation.response
  const body = validation.data

  const { data: order, error: lookupErr } = await db
    .from('orders')
    .select('*')
    .eq('id', params?.id)
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
  if (!hasRoleAtLocation(user, order.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  if (order.status !== 'pending') {
    return NextResponse.json({
      success: false,
      error: `Only pending orders can be cancelled (current status: ${order.status}).`,
      code: 'invalid_status',
    }, { status: 409 })
  }

  // Update the orders projection row. cancelled_at lives on metadata
  // (there's no dedicated column, and reusing abandoned_at would muddy
  // the buyer-abandoned semantics).
  const nowIso = new Date().toISOString()
  const updates = {
    status: 'cancelled',
    metadata: {
      ...(order.metadata || {}),
      cancelled_at: nowIso,
      cancelled_by_user_id: user.id,
      cancel_reason: body.reason || null,
    },
  }
  const { error: updErr } = await db.from('orders').update(updates).eq('id', order.id)
  if (updErr) {
    logError('orders-cancel', 'order update failed', { orderId: order.id, code: updErr.code || null, err: updErr.message })
    return NextResponse.json({ success: false, error: 'Could not cancel the order. Try again.' }, { status: 500 })
  }

  // Cascade to the source row so the projection and the lifecycle source
  // of truth don't diverge (and a future incidental re-sync can't
  // resurrect the pending order). Best-effort — the orders row is the
  // operator-facing record and is already updated. race_payments has no
  // 'cancelled' state, so it lands on 'abandoned' (its terminal
  // "didn't complete"); cars has a first-class 'cancelled' deposit
  // state. NEITHER path emits a contact_event.
  try {
    if (order.source_type === 'race_registration') {
      await db.from('race_payments')
        .update({ status: 'abandoned', abandoned_at: nowIso })
        .eq('id', order.source_id)
        .eq('status', 'pending')
    } else if (order.source_type === 'car_deposit') {
      await db.from('cars')
        .update({ deposit_status: 'cancelled' })
        .eq('id', order.source_id)
    }
  } catch (e) {
    logWarn('orders-cancel', 'source cascade failed', { orderId: order.id, err: e?.message || String(e) })
  }

  return NextResponse.json({
    success: true,
    data: { order_id: order.id, status: 'cancelled', cancelled_at: nowIso },
  })
})
