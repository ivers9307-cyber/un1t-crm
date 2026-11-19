// GET /api/orders/[id]
//
// Single-order detail for the operator drill-in page. Manager+ at
// the order's location.
//
// Returns:
//   data: {
//     order,                 // full row + metadata
//     retry_chain: [...],    // ordered list of related orders
//                            //   (older failed/abandoned + newer
//                            //   successful), buyer-grouped by
//                            //   contact_email + source_type
//     events: [...],         // contact_events for this source_id,
//                            //   newest first, capped at 50
//     source: {              // summary from the originating row
//       race_event?: {...},
//       wave?: {...},
//       team?: {...},
//       car?: {...},
//     },
//   }
//
// The retry chain looks UP via retry_of_order_id (the more recent
// success → older failure pointer) AND DOWN via
// superseded_by_order_id (the older failure → newer success
// pointer) so the operator sees the full history regardless of
// which row they clicked into.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { displayZoneFor } from '@/lib/display-zone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!hasPermissionAtAnyLocation(user, 'orders')) {
    return NextResponse.json({ success: false, error: 'Orders feature is disabled at this location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: order, error } = await db
    .from('orders')
    .select('*')
    .eq('id', params.id)
    .single()
  if (error || !order) {
    return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, order.location_id)
  if (guard) return guard
  // ROLESWEEP.1b — judged at the order's location, not the caller's active studio.
  if (!hasRoleAtLocation(user, order.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!hasPermissionForLocation(user, order.location_id, 'orders')) {
    return NextResponse.json({ success: false, error: 'Orders feature is disabled at this location' }, { status: 403 })
  }

  // Retry chain: every order from the same buyer + source_type
  // within +/- 30 days. Drives the chain visualisation. Capped at
  // 20 rows defensively.
  const dayMs = 86400_000
  const created = order.created_at ? new Date(order.created_at) : new Date()
  const lo = new Date(created.getTime() - 30 * dayMs).toISOString()
  const hi = new Date(created.getTime() + 30 * dayMs).toISOString()
  const { data: chain } = await db
    .from('orders')
    .select('id, status, amount_cents, currency, created_at, completed_at, failed_at, abandoned_at, refunded_at, retry_of_order_id, superseded_by_order_id, payment_provider')
    .eq('contact_email', order.contact_email)
    .eq('source_type', order.source_type)
    .gte('created_at', lo)
    .lte('created_at', hi)
    .order('created_at', { ascending: true })
    .limit(20)

  // Events: for the same source row.
  const { data: events } = await db
    .from('contact_events')
    .select('id, event_type, occurred_at, event_metadata, source_type, source_id')
    .eq('source_type', order.source_type)
    .eq('source_id', order.source_id)
    .order('occurred_at', { ascending: false })
    .limit(50)

  // Source-row summary. Cheap targeted fetch — keeps the response
  // self-contained so the page doesn't need a follow-up call.
  let source = {}
  if (order.source_type === 'race_registration') {
    const { data: payment } = await db
      .from('race_payments')
      .select(`
        id, race_event_id, race_registration_id,
        race:race_event_id ( id, name, slug, race_date, location_id ),
        registration:race_registration_id (
          id, status, registered_at, team_composition, wave_id,
          wave:wave_id ( id, start_time, label ),
          teams:team_id ( id, name, size,
            team_members ( id, name, email, role, is_member ) )
        )
      `)
      .eq('id', order.source_id)
      .maybeSingle()
    if (payment) {
      source = {
        kind: 'race_registration',
        race_event: payment.race,
        wave: payment.registration?.wave,
        registration: payment.registration && {
          id: payment.registration.id,
          status: payment.registration.status,
          team_composition: payment.registration.team_composition,
          registered_at: payment.registration.registered_at,
        },
        team: payment.registration?.teams,
      }
    }
  } else if (order.source_type === 'car_deposit') {
    const { data: car } = await db
      .from('cars')
      .select('id, make, model, irish_reg, buyer_name, buyer_email, buyer_phone, deposit_status, deposit_amount, deposit_paid_amount, deposit_link_sent_at, deposit_paid_at')
      .eq('id', order.source_id)
      .maybeSingle()
    if (car) source = { kind: 'car_deposit', car }
  } else if (order.source_type === 'trial_purchase') {
    // ORDERSTRIALS.1 — what was bought and whether it was granted. A refund
    // here changes nothing on the trial (Richard's decision, 19 Nov 2026):
    // the page says what to undo by hand.
    const { data: trial } = await db
      .from('trial_purchases')
      .select('id, product_name, status, paid_at, granted_at, duration_days, class_name, class_starts_at')
      .eq('id', order.source_id)
      .eq('location_id', order.location_id)
      .maybeSingle()
    if (trial) source = { kind: 'trial_purchase', trial }
  } else if (order.source_type === 'offer_purchase') {
    const { data: purchase } = await db
      .from('offer_purchases')
      .select('id, state, paid_at, fulfilled_at, origin, offer:sale_offers!offer_id ( id, name, category )')
      .eq('id', order.source_id)
      .eq('location_id', order.location_id)
      .maybeSingle()
    if (purchase) source = { kind: 'offer_purchase', purchase }
  } else if (order.source_type === 'class_booking') {
    // ORDERSMORE.1 — each read is pinned to the order's studio as well as its id.
    const { data: booking } = await db
      .from('class_booking_requests')
      .select('id, class_name, starts_at, status, payment_status')
      .eq('id', order.source_id)
      .eq('location_id', order.location_id)
      .maybeSingle()
    if (booking) source = { kind: 'class_booking', booking }
  } else if (order.source_type === 'donation') {
    const { data: donation } = await db
      .from('donations')
      .select('id, status, paid_at, refunded_at, race:race_events!race_event_id ( id, name )')
      .eq('id', order.source_id)
      .eq('location_id', order.location_id)
      .maybeSingle()
    if (donation) source = { kind: 'donation', donation }
  } else if (order.source_type === 'staff_payment_link') {
    const { data: link } = await db
      .from('staff_payment_links')
      .select('id, product_title, status, created_at, paid_at')
      .eq('id', order.source_id)
      .eq('location_id', order.location_id)
      .maybeSingle()
    if (link) source = { kind: 'staff_payment_link', link }
  } else if (order.source_type === 'class_fee') {
    const { data: fee } = await db
      .from('class_fees')
      .select('id, class_title, starts_at, kind, status, charged_at')
      .eq('id', order.source_id)
      .eq('location_id', order.location_id)
      .maybeSingle()
    if (fee) source = { kind: 'class_fee', fee }
  }

  // TZ.16 — the order's studio zone, so the page shows every stamp on that
  // studio's clock (display only: an unreadable zone falls back, logged).
  const timezone = await displayZoneFor(db, user, order.location_id, 'orders')

  return NextResponse.json({
    success: true,
    data: {
      order,
      timezone,
      retry_chain: chain || [],
      events: events || [],
      source,
    },
  })
}
