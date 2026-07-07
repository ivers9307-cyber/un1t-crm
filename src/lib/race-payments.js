// race-payments — UN1T race payment lifecycle (mig 084).
//
// DELIBERATELY SEPARATE from src/lib/deposit-receipts.js and the
// cars deposit flow. UN1T (gym + races) and CCF Autos (cars) are
// different businesses; their payment surfaces and receipts should
// not share code paths even though they both happen to use Revolut
// Merchant under the hood.
//
// What this module owns:
//   - createRacePayment()    — insert a race_payments row + a
//     Revolut order, store both ids
//   - markRacePaymentStatus() — apply a webhook-driven state change
//   - resolveRacePaymentByProviderRef() — webhook lookup
//
// What this module deliberately does NOT do:
//   - Talk to cars.* tables. Ever.
//   - Reuse deposit-receipts templates. Race confirmations live in
//     src/lib/race-confirmations.js with their own copy + branding.
//
// The Revolut HTTP client (src/lib/revolut.js) is the only shared
// piece — it's a generic transport layer with no domain knowledge.
// If a future phase needs per-business credentials (different
// merchant accounts), this module is where the env-var indirection
// would land.

import { paymentsFor } from './payments'
import {
  resolveEventHost,
  resolvePaymentProvider,
  computeApplicationFeeCents,
  hostCanTakePayments,
  PROVIDER_STRIPE_CONNECT,
} from './event-hosts'
import { syncOrderFromRacePayment } from './orders'
import { emitEvent, applyTagRules, EVENT_TYPES } from './contact-events'
import { triggerSequencesForOrderStatus } from './sequences'
import { logWarn } from './log'

/**
 * Resolve which Revolut credentials to use for race payments. For
 * v1 we share the merchant account with cars (REVOLUT_API_KEY); the
 * env var indirection here exists so we can split later by setting
 * REVOLUT_RACE_API_KEY without touching call sites.
 *
 * Side note: the actual key resolution lives inside src/lib/revolut.js
 * via getConfig(). This function is the future hook for swapping in
 * per-domain credentials by temporarily setting process.env at
 * call time. We don't need it yet — both businesses share one
 * merchant account today — so it's just a comment-marker for now.
 */

/**
 * Create a pending race_payments row and a corresponding Revolut
 * order. Returns the inserted row + Revolut handle so the caller
 * (the public register route) can return checkout details to the
 * widget.
 *
 * If amount_cents is 0, no Revolut order is created — the row is
 * inserted with status='completed' immediately (free entry, e.g.
 * members-only race with member_fee_cents=NULL).
 *
 * @param {object} args
 * @param {SupabaseClient} args.db          service-role client
 * @param {object} args.race                race_events row (id, name, payment_currency)
 * @param {object} args.registration        race_registrations row (id, contact_id)
 * @param {object} args.captain             { name, email, phone }
 * @param {object} args.pricing             output of computeTeamPricing
 * @param {string} args.returnUrl           where Revolut sends the buyer post-payment
 * @returns {Promise<{
 *   payment: object,
 *   checkout: { token: string|null, url: string|null, free: boolean }
 * }>}
 */
export async function createRacePayment({ db, race, registration, captain, pricing, returnUrl, cancelUrl }) {
  const amount = Number(pricing?.total_cents || 0)
  const currency = race?.payment_currency || 'EUR'

  // Free entry — no Revolut round-trip.
  if (amount <= 0) {
    const { data: row, error } = await db
      .from('race_payments')
      .insert({
        race_event_id: race.id,
        race_registration_id: registration.id,
        contact_id: registration.contact_id || null,
        contact_email: captain.email,
        contact_phone: captain.phone || null,
        contact_name: captain.name || null,
        amount_cents: 0,
        currency,
        member_count: pricing.member_count,
        non_member_count: pricing.non_member_count,
        member_fee_cents: pricing.member_fee_cents,
        non_member_fee_cents: pricing.non_member_fee_cents,
        status: 'completed',
        payment_provider: 'free',
        completed_at: new Date().toISOString(),
      })
      .select('*')
      .single()
    if (error) throw new Error(`race_payments insert failed: ${error.message}`)
    await db.from('race_registrations')
      .update({ active_payment_id: row.id, status: 'confirmed' })
      .eq('id', registration.id)
    // Project into orders + emit lifecycle events (mig 085).
    // Best-effort — orders/events failures must not break the
    // payment write that's already committed.
    try {
      await syncOrderFromRacePayment({ db, payment: row })
      await emitEvent({
        db,
        eventType: EVENT_TYPES.RACE_REGISTERED,
        contactEmail: captain.email,
        contactId: registration.contact_id || null,
        locationId: race.location_id,
        sourceType: 'race_registration',
        sourceId: row.id,
      })
      await emitEvent({
        db,
        eventType: EVENT_TYPES.ORDER_COMPLETED,
        contactEmail: captain.email,
        contactId: registration.contact_id || null,
        locationId: race.location_id,
        sourceType: 'race_registration',
        sourceId: row.id,
        metadata: { amount_cents: 0, free: true },
      })
      if (registration.contact_id) {
        await applyTagRules({ db, contactId: registration.contact_id })
        // Free entry → fire order_completed sequence trigger (Tier 1A).
        await triggerSequencesForOrderStatus({
          contactId: registration.contact_id,
          locationId: race.location_id,
          status: 'completed',
          sourceType: 'race_registration',
          orderId: row.id,
        })
      }
    } catch (e) {
      logWarn('race-payments', `orders/events sync (free) failed`, { err: e })
    }
    return { payment: row, checkout: { token: null, url: null, free: true } }
  }

  // Paid entry — resolve the host (payee) → processor → per-ticket booking fee.
  // Internal/UN1T events (no host) settle through Revolut exactly as before;
  // third-party-hosted events take a DIRECT charge on the host's Stripe
  // connected account, with the flat booking fee added on top as the
  // application fee. All order creation flows through the payments dispatcher.
  const host = await resolveEventHost(db, race)
  const providerName = resolvePaymentProvider(host) // 'revolut' | 'stripe_connect'
  if (providerName === PROVIDER_STRIPE_CONNECT && !hostCanTakePayments(host)) {
    throw new Error("This event host hasn't finished connecting their Stripe account — payments can't be taken yet.")
  }
  const seatCount = Number(pricing.member_count || 0) + Number(pricing.non_member_count || 0)
  const applicationFee = computeApplicationFeeCents(host, seatCount) // 0 for internal/Revolut
  const chargeAmount = amount + applicationFee                       // customer pays ticket + booking fee

  const created = await paymentsFor(providerName).createPayment({
    amountCents: chargeAmount,
    currency,
    description: `${race.name} — race entry`,
    returnUrl,
    cancelUrl,
    metadata: {
      race_event_id: race.id,
      race_registration_id: registration.id,
      domain: 'un1t_race', // disambiguates from cars in the shared webhook stream
    },
    idempotencyKey: registration.id, // re-issuing for the same registration is safe
    connectedAccountId: host?.stripe_connected_account_id || null,
    applicationFeeCents: applicationFee,
  })

  const { data: row, error } = await db
    .from('race_payments')
    .insert({
      race_event_id: race.id,
      race_registration_id: registration.id,
      contact_id: registration.contact_id || null,
      contact_email: captain.email,
      contact_phone: captain.phone || null,
      contact_name: captain.name || null,
      amount_cents: chargeAmount,
      currency,
      member_count: pricing.member_count,
      non_member_count: pricing.non_member_count,
      member_fee_cents: pricing.member_fee_cents,
      non_member_fee_cents: pricing.non_member_fee_cents,
      status: 'pending',
      payment_provider: providerName,
      payment_provider_ref: created.providerRef,
      payment_checkout_token: created.checkoutToken || null,
      payment_checkout_url: created.checkoutUrl || null,
      connected_account_id: host?.stripe_connected_account_id || null,
      application_fee_cents: applicationFee || null,
      net_to_host_cents: providerName === PROVIDER_STRIPE_CONNECT ? amount : null,
    })
    .select('*')
    .single()
  if (error) throw new Error(`race_payments insert failed: ${error.message}`)

  await db.from('race_registrations')
    .update({ active_payment_id: row.id })
    .eq('id', registration.id)

  // Project into orders + emit lifecycle events (mig 085). The
  // race_payments row is already committed, so any failure here is
  // logged-and-ignored.
  try {
    await syncOrderFromRacePayment({ db, payment: row })
    await emitEvent({
      db,
      eventType: EVENT_TYPES.ORDER_CREATED,
      contactEmail: captain.email,
      contactId: registration.contact_id || null,
      locationId: race.location_id,
      sourceType: 'race_registration',
      sourceId: row.id,
      metadata: { amount_cents: amount, currency },
    })
    await emitEvent({
      db,
      eventType: EVENT_TYPES.RACE_REGISTERED,
      contactEmail: captain.email,
      contactId: registration.contact_id || null,
      locationId: race.location_id,
      sourceType: 'race_registration',
      sourceId: row.id,
    })
    if (registration.contact_id) {
      await applyTagRules({ db, contactId: registration.contact_id })
    }
  } catch (e) {
    logWarn('race-payments', `orders/events sync (paid) failed`, { err: e })
  }

  return {
    payment: row,
    checkout: {
      token: created.checkoutToken || null,
      url: created.checkoutUrl || null,
      free: false,
      provider: providerName,
    },
  }
}

/**
 * Webhook + return-page lookup: find the race_payments row by its
 * provider reference. Returns the row + the parent race_event for
 * convenience.
 *
 * @param {SupabaseClient} db
 * @param {string} providerRef  Revolut order id (uuid string)
 */
export async function resolveRacePaymentByProviderRef(db, providerRef) {
  if (!providerRef) return null
  const { data } = await db
    .from('race_payments')
    .select(`
      *,
      race:race_event_id ( id, name, slug, location_id, race_date, payment_currency,
        locations:location_id ( id, name, twilio_alpha_sender_id ) )
    `)
    .eq('payment_provider_ref', providerRef)
    .maybeSingle()
  return data || null
}

/**
 * Apply a state change driven by a Revolut webhook. Idempotent —
 * callers can fire this for every retry without double-completing.
 * Returns { applied: object|null, state_changed: boolean }.
 *
 * @param {object} args
 * @param {SupabaseClient} args.db
 * @param {object} args.payment    full race_payments row (from resolve...)
 * @param {string} args.revolutState  lowercased Revolut order.state
 * @param {number|null} args.revolutAmount  Revolut order.amount (minor units)
 */
export async function markRacePaymentStatus({ db, payment, revolutState, revolutAmount }) {
  const updates = {}
  const nowIso = new Date().toISOString()

  switch (revolutState) {
    case 'completed':
      if (payment.status !== 'completed') {
        updates.status = 'completed'
        updates.completed_at = payment.completed_at || nowIso
      }
      // Defensive — record the actual captured amount in case it
      // diverged from what we requested (currency rounding etc).
      if (Number.isFinite(revolutAmount) && revolutAmount !== payment.amount_cents) {
        updates.amount_cents = revolutAmount
      }
      break
    case 'failed':
      if (payment.status !== 'failed') {
        updates.status = 'failed'
        updates.failed_at = payment.failed_at || nowIso
      }
      break
    case 'cancelled':
      if (payment.status !== 'abandoned') {
        updates.status = 'abandoned'
        updates.abandoned_at = payment.abandoned_at || nowIso
      }
      break
    default:
      // Transient (pending / processing / authorised) — don't touch.
      return { applied: null, state_changed: false }
  }

  if (Object.keys(updates).length === 0) {
    return { applied: null, state_changed: false }
  }

  await db.from('race_payments').update(updates).eq('id', payment.id)

  // Roll the registration's status forward when the payment lands.
  if (updates.status === 'completed' && payment.race_registration_id) {
    await db.from('race_registrations')
      .update({ status: 'confirmed' })
      .eq('id', payment.race_registration_id)
      .eq('status', 'pending_payment') // don't clobber operator edits
  }

  // Project into orders + emit lifecycle event (mig 085).
  // Best-effort — the payment update is already committed.
  try {
    const refreshed = { ...payment, ...updates }
    await syncOrderFromRacePayment({ db, payment: refreshed })
    const eventTypeByStatus = {
      completed: EVENT_TYPES.ORDER_COMPLETED,
      failed: EVENT_TYPES.ORDER_FAILED,
      abandoned: EVENT_TYPES.ORDER_ABANDONED,
    }
    const evType = eventTypeByStatus[updates.status]
    if (evType) {
      const locId = payment.race?.location_id || null
      await emitEvent({
        db,
        eventType: evType,
        contactEmail: payment.contact_email,
        contactId: payment.contact_id || null,
        locationId: locId,
        sourceType: 'race_registration',
        sourceId: payment.id,
        metadata: { amount_cents: refreshed.amount_cents, currency: payment.currency },
      })
      if (payment.contact_id) {
        await applyTagRules({ db, contactId: payment.contact_id })
        // Fire order_completed/failed/abandoned sequence trigger
        // (Tier 1A). Best-effort — error already swallowed by the
        // outer try/catch in this caller.
        await triggerSequencesForOrderStatus({
          contactId: payment.contact_id,
          locationId: locId,
          status: updates.status,
          sourceType: 'race_registration',
          orderId: payment.id,
        })
      }
    }
  } catch (e) {
    logWarn('race-payments', `orders/events sync (status) failed`, { err: e })
  }

  return { applied: updates, state_changed: true }
}

/**
 * Convenience wrapper for the embedded checkout + return page.
 * Pulls the live order state from Revolut so the front-end can show
 * an accurate status without waiting for the webhook to land.
 */
export async function refreshRacePaymentFromProvider(db, payment) {
  if (!payment?.payment_provider_ref) return payment
  const providerName = payment.payment_provider
  if (providerName !== 'revolut' && providerName !== 'stripe_connect') return payment
  let normalized
  try {
    normalized = await paymentsFor(providerName).getPayment(payment.payment_provider_ref, {
      connectedAccountId: payment.connected_account_id || null,
    })
  } catch {
    return payment
  }
  if (!normalized) return payment
  await markRacePaymentStatus({
    db,
    payment,
    revolutState: normalized.state,
    revolutAmount: Number.isFinite(normalized.amountCents) ? normalized.amountCents : null,
  })
  const { data: refreshed } = await db
    .from('race_payments')
    .select('*')
    .eq('id', payment.id)
    .single()
  return refreshed || payment
}
