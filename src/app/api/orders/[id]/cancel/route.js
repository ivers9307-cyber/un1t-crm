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
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  reason: z.string().max(500).optional(),
})

export async function POST(request, props) {
  const params = await props.params
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

  const guard = assertLocationAccess(user, order.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

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
    return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
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
    console.warn(`[orders-cancel] source cascade failed for order ${order.id}: ${e?.message || e}`)
  }

  return NextResponse.json({
    success: true,
    data: { order_id: order.id, status: 'cancelled', cancelled_at: nowIso },
  })
}
