// POST /api/cars/[id]/cancel-deposit
//
// Operator-side "this deposit isn't happening, close it out". Use
// case: a buyer accepted T&Cs but never paid; or a buyer didn't
// even open the link; or the dealer changed their mind. The
// public deposit page is killed (token cleared so any cached
// link 404s) and the linked orders row flips to 'abandoned'.
//
// Permission: same as issue-deposit-link — anyone with
// car_processing permission. Both actions are reversible (issue a
// new link to bring it back; the cancel doesn't delete data, just
// transitions state).
//
// Refuses on terminal states: paid (the buyer has already paid —
// cancelling would imply a refund flow which lives elsewhere) and
// refunded. Also a no-op on already-cancelled. Failed CAN be
// cancelled — that's a "give up after a failed payment" path.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { syncOrderFromCarDeposit } from '@/lib/orders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CANCELLABLE_STATUSES = new Set(['sent', 'terms_accepted', 'failed'])

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: car } = await db
    .from('cars')
    .select('id, location_id, deposit_status, deposit_token, buyer_email, buyer_name, buyer_phone, deposit_amount, deposit_paid_amount, deposit_revolut_order_id, make, model, vehicle_year, irish_reg')
    .eq('id', params.id)
    .single()
  if (!car) return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })

  const guard = assertLocationAccessOr404(user, car.location_id)
  if (guard) return guard

  if (car.deposit_status === 'cancelled') {
    return NextResponse.json({
      success: true,
      data: { car, already_cancelled: true },
    })
  }

  if (!CANCELLABLE_STATUSES.has(car.deposit_status)) {
    return NextResponse.json({
      success: false,
      error:
        car.deposit_status === 'paid'
          ? 'This deposit has been paid. Use the refund flow on the Orders page instead.'
          : `Cannot cancel a deposit in '${car.deposit_status}' state.`,
      code: 'INVALID_TRANSITION',
    }, { status: 409 })
  }

  // Update both the cars row and the linked orders row in one logical
  // step. Token cleared so the public deposit page on pay.ccfautos.com
  // returns 'invalid deposit link' immediately — important if the
  // SMS was forwarded somewhere it shouldn't be.
  const { data: updated, error: upErr } = await db
    .from('cars')
    .update({
      deposit_status: 'cancelled',
      deposit_token: null,
      deposit_token_expires_at: null,
    })
    .eq('id', car.id)
    .select('*')
    .single()
  if (upErr) {
    return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })
  }

  // Mirror to orders so the Orders tab + the sentinel see the new
  // state. Best-effort — a sync failure shouldn't roll back the
  // cars-side cancel; the operator can retry.
  let orderSync = null
  try {
    orderSync = await syncOrderFromCarDeposit({ db, car: updated })
  } catch (e) {
    console.warn(`[cancel-deposit] order sync failed: ${e?.message || e}`)
  }

  // Audit trail. activities is the canonical place for "operator did
  // X to a car" so the contact timeline + the car detail both pick it
  // up without bespoke storage.
  await db.from('activities').insert({
    location_id: car.location_id,
    car_id: car.id,
    contact_id: null,
    actor_user_id: user.id,
    title: 'Deposit request cancelled',
    description: `Cancelled by ${user.email || user.id}. Previous status: ${car.deposit_status}.`,
    kind: 'event',
  }).then(({ error }) => {
    if (error) console.warn(`[cancel-deposit] activity insert failed: ${error.message}`)
  })

  return NextResponse.json({
    success: true,
    data: {
      car: updated,
      previous_status: car.deposit_status,
      order_synced: !!orderSync,
    },
  })
}
