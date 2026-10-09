// /api/event-registrations/[id]/moves/[moveId]/settle — EVENT-MOVE.3
//
// POST { how: 'collected' | 'waived' } — staff record that a moved entry's
// price difference was collected (by a payment link, cash, …) or waived.
// Records a decision; never moves money. Manager+ holding `races` at the
// entry's CURRENT event studio (the same rule as moving it). Idempotent: a
// settled move answers 200 { unchanged: true }, and the write is a
// compare-and-set on gap_settled_at IS NULL, so a double click (or two staff
// at once) settles it exactly once and the first answer stands. A fresh
// settle also closes any live payment link for the difference (EVENT-MOVE.5).
//
// Status codes: 401 signed out; 403 races held nowhere, or no manager role /
// no races at the entry's studio; 404 an id the caller may not see (entry
// missing or at another studio, move missing or not this entry's); 400 a bad
// body, not_active (the entry is not confirmed), or no_gap (the move left nothing to settle); 500 a read or write
// that FAILED (load_failed, write_failed), never dressed up as a 404.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { readRegistrationForMove } from '@/lib/registration-move'
import { logError, logWarn } from '@/lib/log'
import { syncOrderFromRacePayment } from '@/lib/orders'
import { GAP_PAYMENT_KIND } from '@/lib/registration-entry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const SettleSchema = z.object({ how: z.enum(['collected', 'waived']) })

const MOVE_COLUMNS = 'id, registration_id, to_event_id, price_gap_cents, gap_settled_at, gap_settled_how, gap_settled_by_name'

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const forbidden = () => NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

/**
 * Who settled it, as the move route names its actor: under impersonation (a
 * master acting as someone, see getCurrentUser's impersonatingFrom) the REAL
 * caller, "<master> as <user>", so the history reads true.
 */
function actorName(user) {
  const userName = user.full_name || user.email || 'staff'
  const imp = user.impersonatingFrom
  if (imp?.masterId) return `${imp.masterName || imp.masterEmail || 'master'} as ${userName}`
  return userName
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'races')) return forbidden()
  // A malformed id cannot name a row; reading it would only fail as 22P02.
  if (!uuidLike.safeParse(params.id).success || !uuidLike.safeParse(params.moveId).success) return notFound()

  const db = createServerClient()
  const { registration, error: regErr } = await readRegistrationForMove(db, params.id)
  if (regErr) return NextResponse.json({ success: false, error: 'load_failed', message: 'The entry could not be read. Try again.' }, { status: 500 })
  if (!registration) return notFound()
  // The entry's CURRENT event studio: after a cross-studio move that is the
  // target's, which is where the difference is owed.
  const locationId = registration.race?.location_id
  if (!locationId) return notFound()
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (!hasPermissionForLocation(user, locationId, 'races') || !hasRoleAtLocation(user, locationId, MANAGER_ROLES)) return forbidden()
  // EVENT-MOVE.5 — a cancelled (or unpaid) entry owes no difference.
  if (registration.status !== 'confirmed') {
    return NextResponse.json({ success: false, error: 'not_active', message: 'Only a confirmed entry has a difference to settle.' }, { status: 400 })
  }

  const validation = await validateBody(request, SettleSchema)
  if (!validation.ok) return validation.response

  const { data: move, error: moveErr } = await db
    .from('registration_moves')
    .select(MOVE_COLUMNS)
    .eq('id', params.moveId)
    .maybeSingle()
  if (moveErr) {
    logError('event-move-settle', 'move read failed', { err: moveErr, moveId: params.moveId })
    return NextResponse.json({ success: false, error: 'load_failed', message: 'The move could not be read. Try again.' }, { status: 500 })
  }
  // A move of another entry is as unseen as a missing one: the gate above
  // judged THIS entry's studio, not that one's. So is an earlier move of this
  // entry INTO another event: the difference is settled only on the move that
  // brought it to the event it sits on now (the one the teams page shows).
  if (!move || move.registration_id !== params.id || move.to_event_id !== registration.race_event_id) return notFound()
  if (!(move.price_gap_cents > 0)) {
    return NextResponse.json({ success: false, error: 'no_gap', message: 'This move has no outstanding difference.' }, { status: 400 })
  }
  if (move.gap_settled_at) return NextResponse.json({ success: true, data: { unchanged: true, move } })

  const patch = { gap_settled_at: new Date().toISOString(), gap_settled_how: validation.data.how, gap_settled_by_name: actorName(user) }
  const { data: rows, error: writeErr } = await db
    .from('registration_moves')
    .update(patch)
    .eq('id', params.moveId)
    .is('gap_settled_at', null)
    .select(MOVE_COLUMNS)
  if (writeErr) {
    logError('event-move-settle', 'settle write failed', { err: writeErr, moveId: params.moveId })
    return NextResponse.json({ success: false, error: 'write_failed', message: 'The change could not be saved. Try again.' }, { status: 500 })
  }
  // Zero rows: someone else settled it between the read and the write. Their
  // answer stands; the list reload shows it.
  if (!rows || rows.length === 0) return NextResponse.json({ success: true, data: { unchanged: true, move } })
  await closePendingGapLinks(db, params.moveId)
  return NextResponse.json({ success: true, data: { unchanged: false, move: rows[0] } })
}

/**
 * EVENT-MOVE.5 — settled by hand while a payment link for the difference is
 * live: mark the move's pending move_gap payments abandoned so the checkout
 * stops offering them. Local status only (the provider session just
 * expires); a customer who pays anyway is still recorded, and logged for a
 * refund check. Best-effort: the settle already landed, so this logs and
 * never fails the answer.
 */
async function closePendingGapLinks(db, moveId) {
  const { data: closed, error } = await db
    .from('race_payments')
    .update({ status: 'abandoned', abandoned_at: new Date().toISOString() })
    .eq('registration_move_id', moveId)
    .eq('kind', GAP_PAYMENT_KIND)
    .eq('status', 'pending')
    .select('*')
  if (error) {
    logError('event-move-settle', 'settled, but a live payment link for the difference was NOT closed; the customer could still pay it', { err: error, moveId })
    return
  }
  for (const payment of closed || []) {
    try {
      await syncOrderFromRacePayment({ db, payment })
    } catch (e) {
      logError('event-move-settle', 'closed payment link: order sync failed', { err: e, moveId, paymentId: payment.id })
    }
  }
  if ((closed || []).length > 0) {
    logWarn('event-move-settle', 'settled by hand: closed the live payment link(s) for the difference', { moveId, paymentIds: closed.map((p) => p.id) })
  }
}
