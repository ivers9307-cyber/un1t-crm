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
import { getAppUrl } from './app-url'
import { entryLeadEmail, membersOf } from './registration-entry'
import { logError, logWarn } from './log'

export const GAP_PAYMENT_KIND = 'move_gap'

// The entry's payment rows, newest first. One read answers three questions:
// is there a pending link for this move to reuse, how many links this move has
// had (the idempotency key), and the latest entry payment (contact fallback).
const PAYMENT_COLUMNS = 'id, kind, status, registration_move_id, amount_cents, currency, contact_email, contact_phone, contact_name, payment_provider, payment_checkout_url, created_at'

function leadName(registration, entryPayment) {
  const c = registration?.contact
  const contactName = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim()
  if (contactName) return contactName
  const members = membersOf(registration)
  const captain = members.find((m) => m?.role === 'captain') || members[0]
  return captain?.name || entryPayment?.contact_name || null
}

/**
 * Mint (or reuse) the payment for a move's price difference.
 *
 * @param {object} args
 * @param {import('@supabase/supabase-js').SupabaseClient} args.db  service-role client
 * @param {object} args.move          registration_moves row (id, registration_id, to_event_id, price_gap_cents, gap_settled_at)
 * @param {object} args.registration  the entry (readRegistrationForMove's shape: contact, teams.team_members)
 * @param {object} args.race          the entry's CURRENT event (id, name, location_id, host_id, payment_currency)
 * @param {string} args.returnUrl
 * @param {string} args.cancelUrl
 * @returns {Promise<{ ok: true, payment: object, checkoutUrl: string, reused: boolean }
 *   | { ok: false, error: 'not_this_entry'|'not_current_move'|'no_gap'|'already_settled'|'load_failed'|'no_email'|'host_not_ready'|'provider_failed'|'write_failed' }>}
 */
export async function createGapPayment({ db, move, registration, race, returnUrl, cancelUrl }) {
  if (!move || !registration || move.registration_id !== registration.id) return { ok: false, error: 'not_this_entry' }
  if (move.to_event_id !== registration.race_event_id) return { ok: false, error: 'not_current_move' }
  if (!(Number(move.price_gap_cents) > 0)) return { ok: false, error: 'no_gap' }
  if (move.gap_settled_at) return { ok: false, error: 'already_settled' }

  const { data: rows, error: readErr } = await db
    .from('race_payments')
    .select(PAYMENT_COLUMNS)
    .eq('race_registration_id', registration.id)
    .order('created_at', { ascending: false })
    .limit(50)
  if (readErr) {
    logError('race-gap-payment', 'payments read failed; no link minted', { err: readErr, registrationId: registration.id, moveId: move.id })
    return { ok: false, error: 'load_failed' }
  }
  const payments = Array.isArray(rows) ? rows : []
  const forThisMove = payments.filter((p) => p.kind === GAP_PAYMENT_KIND && p.registration_move_id === move.id)
  const pending = forThisMove.find((p) => p.status === 'pending')
  if (pending) {
    return { ok: true, payment: pending, checkoutUrl: `${getAppUrl()}/event-pay/${pending.id}`, reused: true }
  }
  const entryPayment = payments.find((p) => (p.kind || 'entry') === 'entry') || null

  const email = entryLeadEmail({ registration, payment: entryPayment })
  if (!email) return { ok: false, error: 'no_email' } // race_payments.contact_email is NOT NULL

  const host = await resolveEventHost(db, race)
  const providerName = resolvePaymentProvider(host) // 'revolut' | 'stripe_connect'
  if (providerName === PROVIDER_STRIPE_CONNECT && !hostCanTakePayments(host)) return { ok: false, error: 'host_not_ready' }

  const amount = Number(move.price_gap_cents)
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
      metadata: {
        race_event_id: race?.id || registration.race_event_id,
        race_registration_id: registration.id,
        registration_move_id: move.id,
        domain: 'un1t_race_gap',
      },
      // Scoped to the ATTEMPT, not just the move: Revolut answers a repeated
      // key with the ORIGINAL order, so after an abandoned or failed link a
      // bare `move:<id>` would hand back the dead order, and a second row with
      // the same provider ref would make the webhook lookup ambiguous.
      idempotencyKey: `move:${move.id}:${forThisMove.length}`,
      connectedAccountId,
      applicationFeeCents: 0, // the per-ticket platform fee was taken on the entry
    })
  } catch (e) {
    logError('race-gap-payment', 'provider refused the gap payment; no link minted', { err: e, provider: providerName, registrationId: registration.id, moveId: move.id })
    return { ok: false, error: 'provider_failed' }
  }

  const { data: row, error: insErr } = await db
    .from('race_payments')
    .insert({
      kind: GAP_PAYMENT_KIND,
      registration_move_id: move.id,
      race_event_id: race?.id || registration.race_event_id,
      race_registration_id: registration.id,
      contact_id: registration.contact_id || null,
      contact_email: email,
      contact_phone: entryPayment?.contact_phone || null,
      contact_name: leadName(registration, entryPayment),
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
  if (insErr || !row) {
    // The provider order exists with no ledger row: if it is ever paid the
    // webhook finds nothing. Log the ref so it can be found and cancelled.
    logError('race-gap-payment', 'gap payment insert failed after the provider order was created', {
      err: insErr, provider: providerName, providerRef: created.providerRef, registrationId: registration.id, moveId: move.id,
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

  return { ok: true, payment: row, checkoutUrl: `${getAppUrl()}/event-pay/${row.id}`, reused: false }
}
