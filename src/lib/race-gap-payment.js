// race-gap-payment — EVENT-MOVE.5: a payment for a moved entry's PRICE
// DIFFERENCE (race_payments.kind = 'move_gap', mig 710).
//
// A move never moves money (mig 708). When the target event costs more, staff
// send the customer a link for the difference; when it is paid,
// markRacePaymentStatus settles the move as collected. This module only mints
// (or reuses) that link.
//
// Deliberately NOT createRacePayment: that one is the ENTRY's payment. It
// overwrites race_registrations.active_payment_id, emits RACE_REGISTERED,
// applies tag rules, adds the per-ticket booking fee and keys Revolut's
// idempotency on the registration id. A gap payment does none of that:
//   - active_payment_id keeps pointing at the entry payment (the registration
//     is never touched here);
//   - no booking fee (the platform fee was taken on the entry);
//   - ORDER_CREATED yes (the money is real), RACE_REGISTERED and tags no.
//
// Spec: docs/superpowers/specs/2026-10-08-event-entry-move-design.md

import { paymentsFor } from './payments'
import {
  resolveEventHost,
  resolvePaymentProvider,
  hostCanTakePayments,
  PROVIDER_STRIPE_CONNECT,
} from './event-hosts'
import { syncOrderFromRacePayment } from './orders'
import { emitEvent, EVENT_TYPES } from './contact-events'
import { resolveCustomerBaseUrl } from './tenant-host'
import { entryLeadEmail, entryLeadName, GAP_PAYMENT_KIND } from './registration-entry'
import { logError, logWarn } from './log'
import { recordErrorEvent } from './error-events'
// EVENT-MOVE.6 — a customer's dearer move runs when its difference is paid.
// registration-move imports nothing from the payment modules, so no cycle.
import { moveRegistration } from './registration-move'
// A cycle (race-payments imports completeGapPayment from here); safe, since
// neither module touches the other's bindings at load time.
import { refreshRacePaymentFromProvider } from './race-payments'

export { GAP_PAYMENT_KIND }

// The entry's payment rows, newest first. One read answers three questions:
// is there a pending link for this move to reuse, how many links this move has
// had (the idempotency key), and the latest entry payment (contact fallback).
const PAYMENT_COLUMNS = 'id, kind, status, registration_move_id, amount_cents, currency, contact_email, contact_phone, contact_name, payment_provider, payment_provider_ref, payment_checkout_url, metadata, created_at'

/**
 * EVENT-MOVE.6 — the move a customer's payment is for, as stored in
 * race_payments.metadata.pending_move. Exactly these four fields: the target,
 * the event the move was judged from (the completion refuses as conflict if
 * the entry left it) and who asked.
 */
function pendingMoveRecord(pm) {
  return {
    target_event_id: pm.target_event_id,
    target_wave_id: pm.target_wave_id || null,
    expected_source_event_id: pm.expected_source_event_id,
    actor: pm.actor,
  }
}

/** Is this pending payment for the same customer move (date, time, judged-from event, amount)? */
function samePendingMove(payment, pm, amount) {
  const stored = payment?.metadata?.pending_move
  if (!stored) return false
  return stored.target_event_id === pm.target_event_id
    && (stored.target_wave_id || null) === (pm.target_wave_id || null)
    && stored.expected_source_event_id === pm.expected_source_event_id
    && Number(payment.amount_cents) === Number(amount)
}


/**
 * Mint (or reuse) the payment for a move's price difference.
 *
 * Two shapes. Staff (EVENT-MOVE.5): `move` is the registration_moves row the
 * entry already made, and the payment settles it. Customer (EVENT-MOVE.6):
 * `pendingMove` + `amountCents` instead of `move`, for a move NOT yet made;
 * the row carries metadata.pending_move and no registration_move_id, and its
 * completion (completeGapPayment) makes the move. A new customer link closes
 * any other pending customer link on the entry, so two different changes
 * cannot both be paid.
 *
 * @param {object} args
 * @param {import('@supabase/supabase-js').SupabaseClient} args.db  service-role client
 * @param {object} args.move          registration_moves row (id, registration_id, to_event_id, price_gap_cents, gap_settled_at)
 * @param {object} args.registration  the entry (readRegistrationForMove's shape: contact, teams.team_members)
 * @param {object} args.race          the entry's CURRENT event (id, name, location_id, host_id, payment_currency)
 * @param {string} args.returnUrl
 * @param {string} args.cancelUrl
 * @param {object} [args.pendingMove]  EVENT-MOVE.6: { target_event_id, target_wave_id, expected_source_event_id, actor }
 * @param {number} [args.amountCents]  EVENT-MOVE.6: the difference, judged by checkMove (never the client)
 * @returns {Promise<{ ok: true, payment: object, checkoutUrl: string, reused: boolean }
 *   | { ok: false, error: 'not_this_entry'|'not_current_move'|'no_gap'|'already_settled'|'load_failed'|'no_email'|'host_not_ready'|'provider_failed'|'write_failed' }>}
 */
export async function createGapPayment({ db, move = null, registration, race, returnUrl, cancelUrl, pendingMove = null, amountCents = null }) {
  if (pendingMove) {
    if (!pendingMove.target_event_id || !pendingMove.actor?.type) throw new TypeError('pendingMove needs target_event_id and actor.type')
    if (!registration || move) return { ok: false, error: 'not_this_entry' }
    if (pendingMove.expected_source_event_id !== registration.race_event_id) return { ok: false, error: 'not_current_move' }
    if (!(Number(amountCents) > 0)) return { ok: false, error: 'no_gap' }
  } else {
    if (!move || !registration || move.registration_id !== registration.id) return { ok: false, error: 'not_this_entry' }
    if (move.to_event_id !== registration.race_event_id) return { ok: false, error: 'not_current_move' }
    if (!(Number(move.price_gap_cents) > 0)) return { ok: false, error: 'no_gap' }
    if (move.gap_settled_at) return { ok: false, error: 'already_settled' }
  }
  const amount = pendingMove ? Number(amountCents) : Number(move.price_gap_cents)
  // W1.L3b — every /event-pay/ link below (fresh, reused, or the concurrent
  // winner's) is minted on the EVENT LOCATION's tenant host, resolved once;
  // the resolver floors to the CRM host and never throws past it.
  const baseUrl = await resolveCustomerBaseUrl(db, race?.location_id || null)

  const { data: rows, error: readErr } = await db
    .from('race_payments')
    .select(PAYMENT_COLUMNS)
    .eq('race_registration_id', registration.id)
    .order('created_at', { ascending: false })
    .limit(50)
  if (readErr) {
    logError('race-gap-payment', 'payments read failed; no link minted', { err: readErr, registrationId: registration.id, moveId: move?.id || null })
    return { ok: false, error: 'load_failed' }
  }
  const payments = Array.isArray(rows) ? rows : []
  // Every customer date-change payment this entry ever had, landed ones
  // included: the Revolut idempotency key counts them all (review C1). A
  // landed change is linked to its move, so a count of the unlinked ones
  // alone would hand a SECOND change the first one's key, and Revolut would
  // answer with that old, already-paid order.
  const customerAttempts = payments.filter((p) => p.kind === GAP_PAYMENT_KIND && p.metadata?.pending_move).length
  // The links still open for THIS payment (reuse, closing stale ones): the
  // move's links (staff), or the entry's customer links with no move yet.
  const forThisMove = pendingMove
    ? payments.filter((p) => p.kind === GAP_PAYMENT_KIND && !p.registration_move_id && p.metadata?.pending_move)
    : payments.filter((p) => p.kind === GAP_PAYMENT_KIND && p.registration_move_id === move.id)
  const pending = pendingMove
    ? forThisMove.find((p) => p.status === 'pending' && samePendingMove(p, pendingMove, amount))
    : forThisMove.find((p) => p.status === 'pending')
  if (pending) {
    // Ask the provider first: a Stripe Checkout session expires after 24
    // hours, and a link may have been paid without the webhook landing yet.
    // The refresh applies whatever it finds (abandoned, or completed, which
    // settles the move and sends the receipt).
    const live = (await refreshRacePaymentFromProvider(db, pending)) || pending
    if (live.status === 'pending') {
      return { ok: true, payment: live, checkoutUrl: `${baseUrl}/event-pay/${live.id}`, reused: true }
    }
    if (live.status === 'completed') return { ok: false, error: 'already_settled' }
    // abandoned / failed: mint a fresh link below.
  }
  if (pendingMove) {
    // A pending customer link for another date or time: close it before
    // minting this one (local status, as the staff settle route does; the
    // checkout then says it has expired). If it is paid anyway its move is
    // refused on completion and the failure is loud.
    const stale = forThisMove.filter((p) => p.status === 'pending' && p.id !== pending?.id).map((p) => p.id)
    if (stale.length > 0) await closeCustomerGapLinks(db, registration.id, { ids: stale })
  }
  const entryPayment = payments.find((p) => (p.kind || 'entry') === 'entry') || null

  const email = entryLeadEmail({ registration, payment: entryPayment })
  if (!email) return { ok: false, error: 'no_email' } // race_payments.contact_email is NOT NULL

  const host = await resolveEventHost(db, race)
  const providerName = resolvePaymentProvider(host) // 'revolut' | 'stripe_connect'
  if (providerName === PROVIDER_STRIPE_CONNECT && !hostCanTakePayments(host)) return { ok: false, error: 'host_not_ready' }

  const currency = race?.payment_currency || 'EUR'
  const connectedAccountId = host?.stripe_connected_account_id || null

  let created
  try {
    created = await paymentsFor(providerName).createPayment({
      amountCents: amount,
      currency,
      description: `${race?.name || 'Event'} — price difference`,
      returnUrl,
      cancelUrl,
      metadata: pendingMove
        ? {
            race_event_id: race?.id || registration.race_event_id,
            race_registration_id: registration.id,
            pending_move_target_event_id: pendingMove.target_event_id,
            domain: 'un1t_race_gap',
          }
        : {
            race_event_id: race?.id || registration.race_event_id,
            race_registration_id: registration.id,
            registration_move_id: move.id,
            domain: 'un1t_race_gap',
          },
      // Scoped to the ATTEMPT, not just the move: Revolut answers a repeated
      // key with the ORIGINAL order, so after an abandoned or failed link a
      // bare `move:<id>` would hand back the dead order, and a second row with
      // the same provider ref would make the webhook lookup ambiguous.
      idempotencyKey: pendingMove
        ? `pending-move:${registration.id}:${customerAttempts}`
        : `move:${move.id}:${forThisMove.length}`,
      connectedAccountId,
      applicationFeeCents: 0, // the per-ticket platform fee was taken on the entry
    })
  } catch (e) {
    logError('race-gap-payment', 'provider refused the gap payment; no link minted', { err: e, provider: providerName, registrationId: registration.id, moveId: move?.id || null })
    return { ok: false, error: 'provider_failed' }
  }

  const { data: row, error: insErr } = await db
    .from('race_payments')
    .insert({
      kind: GAP_PAYMENT_KIND,
      registration_move_id: move?.id || null,
      ...(pendingMove ? { metadata: { pending_move: pendingMoveRecord(pendingMove) } } : {}),
      race_event_id: race?.id || registration.race_event_id,
      race_registration_id: registration.id,
      contact_id: registration.contact_id || null,
      contact_email: email,
      contact_phone: entryPayment?.contact_phone || null,
      // The person the address belongs to (the link email greets them).
      contact_name: entryLeadName({ registration, payment: entryPayment }),
      amount_cents: amount,
      currency,
      // member_count / non_member_count are NOT NULL DEFAULT 0: left to the
      // default. A difference has no per-person breakdown.
      member_fee_cents: null,
      non_member_fee_cents: null,
      status: 'pending',
      payment_provider: providerName,
      payment_provider_ref: created.providerRef,
      payment_checkout_token: created.checkoutToken || null,
      payment_checkout_url: created.checkoutUrl || null,
      connected_account_id: connectedAccountId,
      application_fee_cents: null,
      net_to_host_cents: providerName === PROVIDER_STRIPE_CONNECT ? amount : null,
    })
    .select('*')
    .single()
  if (insErr?.code === '23505' && move) {
    // race_payments_one_pending_gap_per_move (mig 710): a concurrent click
    // minted the pending link first. Hand back theirs; ours is a provider
    // order nobody will pay (a Stripe session expires on its own).
    const { data: winner, error: winErr } = await db
      .from('race_payments')
      .select(PAYMENT_COLUMNS)
      .eq('registration_move_id', move.id)
      .eq('kind', GAP_PAYMENT_KIND)
      .eq('status', 'pending')
      .maybeSingle()
    if (!winErr && winner) {
      logWarn('race-gap-payment', 'lost the race to mint a gap link; reusing the winner, our provider order is unused', {
        provider: providerName, providerRef: created.providerRef, paymentId: winner.id, moveId: move.id,
      })
      return { ok: true, payment: winner, checkoutUrl: `${baseUrl}/event-pay/${winner.id}`, reused: true }
    }
  }
  if (insErr || !row) {
    // The provider order exists with no ledger row: if it is ever paid the
    // webhook finds nothing. Log the ref so it can be found and cancelled.
    logError('race-gap-payment', 'gap payment insert failed after the provider order was created', {
      err: insErr, provider: providerName, providerRef: created.providerRef, registrationId: registration.id, moveId: move?.id || null,
    })
    return { ok: false, error: 'write_failed' }
  }

  // The money is real, so it is an order. Best-effort, as for entries: the
  // payment row is committed.
  try {
    await syncOrderFromRacePayment({ db, payment: row })
    await emitEvent({
      db,
      eventType: EVENT_TYPES.ORDER_CREATED,
      contactEmail: email,
      contactId: registration.contact_id || null,
      locationId: race?.location_id || null,
      sourceType: 'race_registration',
      sourceId: row.id,
      metadata: { amount_cents: amount, currency, kind: GAP_PAYMENT_KIND },
    })
  } catch (e) {
    logWarn('race-gap-payment', 'orders/events sync (gap created) failed', { err: e, paymentId: row.id })
  }

  return { ok: true, payment: row, checkoutUrl: `${baseUrl}/event-pay/${row.id}`, reused: false }
}

/**
 * EVENT-MOVE.6 — close the entry's open customer date-change links: pending
 * move_gap payments with no move yet (a staff link always has its move).
 * Local status, as the staff settle route does: the checkout then says the
 * link has expired. Used when a newer change is minted (`ids`: the stale
 * ones) and after an equal-or-cheaper change moved the entry at once (every
 * open one), so an older dearer link cannot be paid for a change that no
 * longer applies. Best-effort: logs, never throws.
 *
 * @param {object} db
 * @param {string} registrationId
 * @param {{ ids?: string[]|null }} [opts]
 */
export async function closeCustomerGapLinks(db, registrationId, { ids = null } = {}) {
  let q = db.from('race_payments').update({ status: 'abandoned', abandoned_at: new Date().toISOString() })
  q = Array.isArray(ids)
    ? q.in('id', ids)
    : q.eq('race_registration_id', registrationId).eq('kind', GAP_PAYMENT_KIND).is('registration_move_id', null)
  const { data: closed, error } = await q.eq('status', 'pending').select('*')
  if (error) {
    logError('race-gap-payment', 'an open date-change link was NOT closed; the customer could still pay it', { err: error, registrationId, paymentIds: ids })
    return
  }
  for (const payment of Array.isArray(closed) ? closed : []) {
    try {
      await syncOrderFromRacePayment({ db, payment })
    } catch (e) {
      logWarn('race-gap-payment', 'closed date-change link: order sync failed', { err: e, registrationId, paymentId: payment?.id })
    }
  }
}

/**
 * EVENT-MOVE.5 — the completed branch for kind='move_gap'. Projects the order
 * and emits ORDER_COMPLETED (the money is real), then settles the move with
 * the same compare-and-set as the staff settle route (EVENT-MOVE.3), so a
 * difference staff already marked by hand keeps their answer. Never: the
 * registration status, the host contact list, tag rules, order_completed
 * sequences. The caller (the payment webhooks) sends the gap receipt instead
 * of the entry confirmation, and skips the Glofox push.
 *
 * EVENT-MOVE.6 — a customer's payment (metadata.pending_move, no move yet)
 * makes its move first (landPendingMove), then settles that move. A move
 * refused after the money landed answers `pending_move_failed: <code>`; the
 * payment stays completed and the receipt says we will be in touch.
 */
export async function completeGapPayment({ db, payment, updates, nowIso }) {
  try {
    const refreshed = { ...payment, ...updates }
    await syncOrderFromRacePayment({ db, payment: refreshed })
    await emitEvent({
      db,
      eventType: EVENT_TYPES.ORDER_COMPLETED,
      contactEmail: payment.contact_email,
      contactId: payment.contact_id || null,
      locationId: payment.race?.location_id || null,
      sourceType: 'race_registration',
      sourceId: payment.id,
      metadata: { amount_cents: refreshed.amount_cents, currency: payment.currency, kind: GAP_PAYMENT_KIND },
    })
  } catch (e) {
    logWarn('race-gap-payment', 'orders/events sync (gap completed) failed', { err: e, paymentId: payment.id })
  }

  let moveId = payment.registration_move_id || null
  const pendingMove = moveId ? null : (payment.metadata?.pending_move || null)
  if (pendingMove) {
    const paidCents = Number({ ...payment, ...updates }.amount_cents)
    const landed = await landPendingMove({ db, payment, pendingMove, nowIso, paidCents })
    if (!landed.ok) {
      return { applied: { ...updates, kind: GAP_PAYMENT_KIND }, state_changed: true, pending_move_failed: landed.error }
    }
    // Underpaid against the move's own gap: leave it outstanding, so the
    // teams page chip shows staff the difference (review I4).
    if (landed.settle === false) return { applied: { ...updates, kind: GAP_PAYMENT_KIND }, state_changed: true }
    moveId = landed.moveId
  }

  if (!moveId) {
    logError('race-gap-payment', 'a move_gap payment completed with no move to settle; mark the difference collected by hand', { paymentId: payment.id })
  } else {
    const { data: settled, error: settleErr } = await db
      .from('registration_moves')
      .update({ gap_settled_at: nowIso, gap_settled_how: 'collected', gap_settled_by_name: 'Customer (paid online)' })
      .eq('id', moveId)
      .is('gap_settled_at', null)
      .select('id')
    if (settleErr) {
      logError('race-gap-payment', 'the difference was paid but the move was NOT marked collected; mark it by hand', { err: settleErr, paymentId: payment.id, moveId })
    } else if (!Array.isArray(settled) || settled.length === 0) {
      // Staff settled it first (collected by hand, or waived) and the customer
      // paid anyway: their answer stands, and the money may need refunding.
      logError('race-gap-payment', 'the difference was paid online after the move was already settled; check whether to refund', { paymentId: payment.id, moveId })
    }
  }

  return { applied: { ...updates, kind: GAP_PAYMENT_KIND }, state_changed: true }
}

/**
 * EVENT-MOVE.6 — the customer paid the difference: make the move they asked
 * for, under the same rules as any move (no force: a time that filled while
 * they paid is refused), from the event it was judged on. On success the
 * payment is linked to the new move row (the receipt reads its old event
 * from there). On a refusal the money is NOT given back by code: the payment
 * stays completed, metadata.pending_move_failed records why, and it is loud
 * (logError + an error_events row Sentinel pages on) because a person paid
 * for something that did not happen.
 *
 * The move computes its own gap at the moment it lands; prices can change
 * between the checkout and the webhook. A different gap is recorded on the
 * payment (metadata.gap_mismatch = { paid, gap }) and warned; underpaid, the
 * move is NOT settled (settle: false) so the difference stays visible.
 *
 * @returns {Promise<{ ok: true, moveId: string, settle: boolean } | { ok: false, error: string }>}
 */
async function landPendingMove({ db, payment, pendingMove, nowIso, paidCents }) {
  let result
  try {
    result = await moveRegistration(db, {
      registrationId: payment.race_registration_id,
      targetEventId: pendingMove.target_event_id,
      targetWaveId: pendingMove.target_wave_id || null,
      actor: pendingMove.actor,
      notify: true,
      force: false,
      expectedSourceEventId: pendingMove.expected_source_event_id || null,
    })
  } catch (e) {
    logError('race-gap-payment', 'the paid date change threw while moving the entry', { err: e, paymentId: payment.id })
    result = { ok: false, error: 'move_threw' }
  }

  if (result?.ok && result.move?.id) {
    const moveId = result.move.id
    const gap = Number(result.move.price_gap_cents)
    const paid = Number.isFinite(paidCents) ? paidCents : Number(payment.amount_cents)
    const mismatch = Number.isFinite(gap) && Number.isFinite(paid) && gap !== paid
    const patch = { registration_move_id: moveId }
    if (mismatch) {
      patch.metadata = { ...(payment.metadata || {}), gap_mismatch: { paid, gap } }
      // Underpaid pages (Sentinel reads error-level): the chip shows the full
      // gap and staff could charge it again on top of what was paid.
      const log = paid < gap ? logError : logWarn
      log('race-gap-payment', paid < gap
        ? 'the customer paid LESS than the gap the move recorded; the difference is left outstanding, check before charging again'
        : 'the paid difference differs from the gap the move recorded; check the move', {
        paymentId: payment.id, moveId, paid, gap, settled: paid >= gap,
      })
    }
    const { data: linked, error: linkErr } = await db
      .from('race_payments')
      .update(patch)
      .eq('id', payment.id)
      .select('id')
    if (linkErr || !Array.isArray(linked) || linked.length === 0) {
      logError('race-gap-payment', 'the entry moved and the difference is paid, but the payment was NOT linked to its move; set race_payments.registration_move_id by hand', {
        err: linkErr || null, paymentId: payment.id, moveId,
      })
    }
    return { ok: true, moveId, settle: !(mismatch && paid < gap) }
  }

  const error = result?.error || 'move_failed'
  const { error: metaErr } = await db
    .from('race_payments')
    .update({ metadata: { ...(payment.metadata || {}), pending_move_failed: { error, at: nowIso } } })
    .eq('id', payment.id)
  if (metaErr) logError('race-gap-payment', 'could not record the refused date change on the payment', { err: metaErr, paymentId: payment.id })
  logError('race-gap-payment', 'a customer PAID for a date change that was then refused; the payment stands. Contact them: move the entry by hand or refund', {
    paymentId: payment.id, registrationId: payment.race_registration_id, targetEventId: pendingMove.target_event_id, error,
  })
  await recordErrorEvent({
    vercel_id: null,
    runtime: process.env.NEXT_RUNTIME || null,
    route_path: 'move_gap:pending_move',
    route_type: 'move_gap',
    method: null,
    name: 'pending_move_failed',
    message: `Customer paid a date-change difference (race_payments ${payment.id}) but the move was refused (${error}); the payment stands. Contact them: move by hand or refund.`.slice(0, 500),
    digest: null,
  })
  return { ok: false, error }
}
