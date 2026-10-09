// /api/event-registrations/[id]/moves/[moveId]/gap-link — EVENT-MOVE.5
//
// POST { email?: boolean } — staff get a payment link for a moved entry's
// price difference (race_payments.kind = 'move_gap', mig 710) and, with
// email: true, send it to the payer. Paying it settles the move as collected
// (markRacePaymentStatus). A pending link for the move is reused, never
// minted twice. Gated exactly like the settle route: manager+ holding `races`
// at the entry's CURRENT event studio; the move must be this entry's, and the
// one that brought it to the event it is on now.
//
// Status codes: 401 signed out; 403 races held nowhere, or no manager role /
// no races at the entry's studio; 404 an id the caller may not see; 400 a bad
// body, not_active (the entry is not confirmed), no_gap, or no_email (nobody on the entry has an address); 409
// already_settled, or host_not_ready (a Stripe host not yet able to take
// payments); 502 provider_failed; 500 load_failed / write_failed.
// The email is best-effort: a link that was minted answers 200 with
// `emailed: false` when the email did not go, so staff can still copy it.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { readRegistrationForMove } from '@/lib/registration-move'
import { createGapPayment } from '@/lib/race-gap-payment'
import { sendGapLinkEmail } from '@/lib/race-confirmations'
import { getAppUrl } from '@/lib/app-url'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GapLinkSchema = z.object({ email: z.boolean().optional() })

const MOVE_COLUMNS = 'id, registration_id, to_event_id, price_gap_cents, gap_settled_at, gap_settled_how, gap_settled_by_name'

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const forbidden = () => NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

// createGapPayment's refusals → status + plain English. Keyed by code so the
// UI never invents copy.
const REFUSALS = {
  already_settled: [409, 'This difference is already settled.'],
  no_gap: [400, 'This move has no outstanding difference.'],
  no_email: [400, 'Nobody on this entry has an email address, so there is no one to pay from.'],
  host_not_ready: [409, "This event's host hasn't finished connecting Stripe, so payments can't be taken yet."],
  provider_failed: [502, 'The payment provider did not create the link. Try again.'],
  load_failed: [500, 'The entry\'s payments could not be read. Try again.'],
  write_failed: [500, 'The link could not be saved. Try again.'],
  not_this_entry: [404, 'Not found'],
  not_current_move: [404, 'Not found'],
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'races')) return forbidden()
  if (!uuidLike.safeParse(params.id).success || !uuidLike.safeParse(params.moveId).success) return notFound()

  const db = createServerClient()
  const { registration, error: regErr } = await readRegistrationForMove(db, params.id)
  if (regErr) return NextResponse.json({ success: false, error: 'load_failed', message: 'The entry could not be read. Try again.' }, { status: 500 })
  if (!registration) return notFound()
  const race = registration.race
  const locationId = race?.location_id
  if (!locationId) return notFound()
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (!hasPermissionForLocation(user, locationId, 'races') || !hasRoleAtLocation(user, locationId, MANAGER_ROLES)) return forbidden()
  // EVENT-MOVE.5 — a cancelled (or unpaid) entry owes no difference.
  if (registration.status !== 'confirmed') {
    return NextResponse.json({ success: false, error: 'not_active', message: 'Only a confirmed entry has a difference to settle.' }, { status: 400 })
  }

  const validation = await validateBody(request, GapLinkSchema)
  if (!validation.ok) return validation.response

  const { data: move, error: moveErr } = await db
    .from('registration_moves')
    .select(MOVE_COLUMNS)
    .eq('id', params.moveId)
    .maybeSingle()
  if (moveErr) {
    logError('event-move-gap-link', 'move read failed', { err: moveErr, moveId: params.moveId })
    return NextResponse.json({ success: false, error: 'load_failed', message: 'The move could not be read. Try again.' }, { status: 500 })
  }
  // As in the settle route: another entry's move, or an earlier move of this
  // entry into some other event, is as unseen as a missing one.
  if (!move || move.registration_id !== params.id || move.to_event_id !== registration.race_event_id) return notFound()
  if (!(move.price_gap_cents > 0)) {
    return NextResponse.json({ success: false, error: 'no_gap', message: REFUSALS.no_gap[1] }, { status: 400 })
  }
  if (move.gap_settled_at) {
    const how = move.gap_settled_how || 'settled'
    const who = (typeof move.gap_settled_by_name === 'string' && move.gap_settled_by_name.trim()) || 'staff'
    return NextResponse.json({ success: false, error: 'already_settled', message: `This difference was already marked ${how} by ${who}.` }, { status: 409 })
  }

  const appUrl = getAppUrl()
  const created = await createGapPayment({
    db,
    move,
    registration,
    race,
    returnUrl: `${appUrl}/event/${race.slug}/confirmed?registration=${registration.id}`,
    cancelUrl: `${appUrl}/event/${race.slug}`,
  })
  if (!created.ok) {
    const [status, message] = REFUSALS[created.error] || [500, 'The link could not be created. Try again.']
    return NextResponse.json({ success: false, error: created.error, message }, { status })
  }

  let emailed = false
  if (validation.data.email === true) {
    try {
      const r = await sendGapLinkEmail({ db, paymentId: created.payment.id, payUrl: created.checkoutUrl })
      emailed = Array.isArray(r?.sent) && r.sent.includes('email')
    } catch (e) {
      logError('event-move-gap-link', 'gap link email threw; the link stands and staff hold it', { err: e, moveId: move.id, paymentId: created.payment.id })
    }
  }

  return NextResponse.json({
    success: true,
    data: { payment_id: created.payment.id, url: created.checkoutUrl, reused: created.reused === true, emailed },
  })
}
