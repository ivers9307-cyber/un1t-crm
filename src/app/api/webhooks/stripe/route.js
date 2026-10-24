// POST /api/webhooks/stripe — Stripe Connect webhook (EVENTS-HOST.2).
//
// Register ONE endpoint in the Stripe dashboard pointing here, with "listen to
// events on connected accounts" enabled, so host account.updated (and later
// payout / payment_intent) events arrive. Its signing secret is
// STRIPE_WEBHOOK_SECRET.
//
// Signature-verified via verifyStripeWebhook (constructEvent) on the RAW body.
// Idempotent: account.updated is a state sync (applying the same account twice
// is harmless) and charge.refunded writes Stripe's CUMULATIVE amount_refunded
// absolutely (HOST-PORTAL.7), so no dedup table is needed here. Always returns
// 200 for handled/unrecognised events so Stripe doesn't disable the endpoint;
// a bad signature is the only 4xx.

import { NextResponse } from 'next/server'
import { verifyStripeWebhook, getStripe } from '@/lib/stripe'
import { createServerClient } from '@/lib/supabase'
import { resolveRacePaymentByProviderRef, markRacePaymentStatus } from '@/lib/race-payments'
import { syncOrderFromRacePayment } from '@/lib/orders'
import { sendRaceConfirmations, sendGapPaidEmail } from '@/lib/race-confirmations'
import { refundPatchFromCharge } from '@/lib/stripe-refund-sync'
import { resolveClassBookingPaymentByRef, markClassBookingPaymentStatus } from '@/lib/class-booking-payments'
import {
  DONATION_COLS,
  resolveDonationByRef,
  markDonationPaymentStatus,
  markDonationRefunded,
  runPaidDonationSideEffects,
} from '@/lib/donation-payments'
import { resolveCharitySettings } from '@/lib/charity-donations'
import { publishQueuePush, CLASS_BOOKINGS_WORKER_PATH } from '@/lib/qstash'
import { logWarn, logError } from '@/lib/log'
import { GAP_PAYMENT_KIND } from '@/lib/registration-entry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DONATION_EVENT_COLS = 'id, name, slug, location_id, host_id, sending_location_id, charity_enabled, charity, payment_currency'

// CHARITY.7 — a donation's Checkout Session completed. Mark, RE-READ the row
// (side effects get it as stored, never a guess), then run the stamp-keyed side
// effects on every observation of a paid row: a Stripe retry reaches here on an
// already-paid donation and the stamps make the effects idempotent. The event
// is read whatever its charity switch says now: the money was taken. An
// unreadable event row skips both steps (logged) so a later observation redoes
// them.
async function settleDonationCompleted(db, session) {
  const donation = await resolveDonationByRef(db, session.id)
  if (!donation) return
  const { data: race, error: raceErr } = await db.from('race_events').select(DONATION_EVENT_COLS).eq('id', donation.race_event_id).maybeSingle()
  if (raceErr || !race) {
    logWarn('stripe-webhook', 'donation event row unreadable', { donationId: donation.id, err: raceErr })
    return
  }
  const marked = await markDonationPaymentStatus({
    db,
    donation,
    providerState: 'completed',
    providerAmount: Number.isFinite(session.amount_total) ? session.amount_total : null,
    multiplier: resolveCharitySettings(race).match_multiplier,
  })
  const { data: fresh, error: readErr } = await db.from('donations').select(DONATION_COLS).eq('id', donation.id).maybeSingle()
  if (readErr || !fresh) {
    logWarn('stripe-webhook', 'donation re-read after mark failed', { donationId: donation.id, err: readErr })
    return
  }
  if (fresh.status === 'paid') {
    try {
      // observerWon: only the delivery that flipped the row sends in the first minute.
      await runPaidDonationSideEffects({ db, donation: fresh, race, ipAddress: null, observerWon: marked?.changed === true })
    } catch (e) {
      logWarn('stripe-webhook', 'donation paid side effects failed', { err: e, donationId: donation.id })
    }
  }
}

export async function POST(request) {
  const signature = request.headers.get('stripe-signature') || ''
  let event
  try {
    const rawBody = await request.text()
    event = verifyStripeWebhook(rawBody, signature)
  } catch (e) {
    return NextResponse.json(
      { success: false, error: `Invalid Stripe signature: ${e.message || 'unknown'}` },
      { status: 400 },
    )
  }

  try {
    if (event.type === 'account.updated') {
      const account = event.data.object
      const db = createServerClient()
      const { data: host } = await db
        .from('event_hosts')
        .select('id, onboarding_completed_at')
        .eq('stripe_connected_account_id', account.id)
        .maybeSingle()
      if (host) {
        const updates = {
          charges_enabled: !!account.charges_enabled,
          payouts_enabled: !!account.payouts_enabled,
          details_submitted: !!account.details_submitted,
          requirements_currently_due: account.requirements?.currently_due || [],
        }
        if (account.charges_enabled && !host.onboarding_completed_at) {
          updates.onboarding_completed_at = new Date().toISOString()
        }
        await db.from('event_hosts').update(updates).eq('id', host.id)
      }
    } else if (event.type === 'checkout.session.completed') {
      // A third-party host's ticket payment succeeded. markRacePaymentStatus
      // confirms the registration + projects the order + fires sequences
      // (idempotent — safe on Stripe retries); then send confirmations once.
      const session = event.data.object
      const db = createServerClient()
      if (session.metadata?.domain === 'un1t_class_booking') {
        // A class-funnel intro payment. Separate lifecycle from race_payments
        // (class_booking_requests) — resolve + release are both idempotent, so
        // a Stripe retry after a first successful release is a safe no-op.
        const row = await resolveClassBookingPaymentByRef(db, session.id)
        if (row) {
          const { released } = await markClassBookingPaymentStatus({
            db,
            request: row,
            providerState: 'completed',
            providerAmount: Number.isFinite(session.amount_total) ? session.amount_total : null,
          })
          if (released) {
            try {
              await publishQueuePush({
                path: CLASS_BOOKINGS_WORKER_PATH,
                body: { id: row.id },
                deduplicationId: `class-booking-${row.id}`,
              })
            } catch {
              // Queue publish is best-effort here — the row is already 'queued'
              // in the DB, which is the durable guarantee; a drain/poll path
              // still picks it up. Never let a queue hiccup fail the webhook.
            }
          }
        }
        return NextResponse.json({ received: true })
      }
      if (session.metadata?.domain === 'un1t_donation') {
        await settleDonationCompleted(db, session)
        return NextResponse.json({ received: true })
      }
      const payment = await resolveRacePaymentByProviderRef(db, session.id)
      if (payment) {
        const result = await markRacePaymentStatus({
          db,
          payment,
          revolutState: 'completed',
          revolutAmount: Number.isFinite(session.amount_total) ? session.amount_total : null,
        })
        if (result.applied?.status === 'completed' && payment.kind === GAP_PAYMENT_KIND) {
          // EVENT-MOVE.5 — a paid price difference: markRacePaymentStatus
          // settled the move; the payer gets the gap receipt, never the
          // entry confirmation.
          try {
            await sendGapPaidEmail({ db, paymentId: payment.id })
          } catch (e) {
            logWarn('stripe-webhook', 'gap receipt failed', { err: e, paymentId: payment.id })
          }
        } else if (result.applied?.status === 'completed') {
          try {
            await sendRaceConfirmations({ db, paymentId: payment.id })
          } catch (e) {
            logWarn('stripe-webhook', 'race confirmations failed', { err: e, paymentId: payment.id })
          }
        }
      }
    } else if (event.type === 'checkout.session.expired') {
      const session = event.data.object
      const db = createServerClient()
      if (session.metadata?.domain === 'un1t_class_booking') {
        const row = await resolveClassBookingPaymentByRef(db, session.id)
        if (row) await markClassBookingPaymentStatus({ db, request: row, providerState: 'cancelled', providerAmount: null })
        return NextResponse.json({ received: true })
      }
      if (session.metadata?.domain === 'un1t_donation') {
        const donation = await resolveDonationByRef(db, session.id)
        if (donation) await markDonationPaymentStatus({ db, donation, providerState: 'expired', providerAmount: null })
        return NextResponse.json({ received: true })
      }
      const payment = await resolveRacePaymentByProviderRef(db, session.id)
      if (payment) {
        await markRacePaymentStatus({ db, payment, revolutState: 'cancelled', revolutAmount: null })
      }
    } else if (event.type === 'charge.refunded') {
      // A refund issued Stripe-side (host dashboard refund) never hits our
      // staff refund route, so sync it into race_payments here or
      // aggregateHostRevenue silently overstates. (Disputes are NOT this
      // event — Stripe emits charge.dispute.* for those; dispute handling is
      // deliberately deferred.) Direct charges live on the CONNECTED account,
      // so the checkout-session lookup must be scoped via stripeAccount:
      // event.account. Own try/catch: a sync failure is logged at error level
      // but still 200s (Stripe re-delivers charge.refunded on later refunds,
      // and the absolute write self-heals).
      try {
        const charge = event.data.object
        const paymentIntentId =
          typeof charge.payment_intent === 'string'
            ? charge.payment_intent
            : charge.payment_intent?.id || null
        const db = createServerClient()
        let session = null
        if (paymentIntentId) {
          const sessions = await getStripe().checkout.sessions.list(
            { payment_intent: paymentIntentId, limit: 1 },
            event.account ? { stripeAccount: event.account } : undefined,
          )
          session = sessions?.data?.[0] || null
        }
        if (!session) {
          // No checkout session for this payment_intent. Hosts run their own
          // Standard Stripe accounts, so refunds on charges taken outside the
          // events platform are NORMAL traffic here — not an error, just fall
          // through to the 200.
          if (process.env.NODE_ENV !== 'production') {
            console.warn('[stripe-webhook] charge.refunded: no checkout session for charge', charge.id)
          }
        } else {
          const payment = await resolveRacePaymentByProviderRef(db, session.id)
          if (!payment) {
            // CHARITY.7 — not a race payment: a donation's Checkout Session
            // lives in `donations`. A Stripe-side refund is recorded with no
            // staff actor (markDonationRefunded only moves paid -> refunded,
            // so redeliveries and unpaid rows are no-ops).
            const donation = await resolveDonationByRef(db, session.id)
            if (donation) {
              await markDonationRefunded({ db, donationId: donation.id, byProfileId: null })
            } else {
              // A session WAS found but neither ledger has a row for it — one
              // of our own checkouts with no ledger row. That's an anomaly
              // worth surfacing (still 200s below).
              logError('stripe-webhook', 'charge.refunded: no matching race_payment', {
                chargeId: charge.id,
                sessionId: session.id,
                account: event.account || null,
              })
            }
          } else {
            if (payment.kind === GAP_PAYMENT_KIND) {
              // EVENT-MOVE.5 — a refunded price difference does NOT un-settle
              // its move: whether the customer still owes it is staff's call.
              logWarn('stripe-webhook', 'charge.refunded on a move_gap payment; the move stays settled, staff decide', {
                paymentId: payment.id, moveId: payment.registration_move_id || null,
              })
            }
            const patch = refundPatchFromCharge(charge, payment, new Date().toISOString())
            if (patch) {
              // Atomic monotonic write: the filter re-checks the cumulative in
              // the UPDATE itself, so only a strictly-greater amount lands —
              // two concurrent deliveries (e.g. 1000 and 5000) can't end below
              // the true total. Zero rows updated just means another delivery
              // already wrote >=.
              const { error: upErr } = await db
                .from('race_payments')
                .update(patch)
                .eq('id', payment.id)
                .or(`refunded_amount_cents.is.null,refunded_amount_cents.lt.${patch.refunded_amount_cents}`)
                .select('id')
              if (upErr) {
                // A swallowed write failure would 200 (so Stripe never
                // retries) with zero trace — log it before falling through.
                logError('stripe-webhook', 'charge.refunded: race_payments update failed', {
                  err: upErr,
                  paymentId: payment.id,
                })
              } else {
                // Project into orders so the staff ledger converges — the
                // staff refund route computes its cumulative from the ORDERS
                // row, so skipping this lets a later staff refund regress
                // race_payments. Re-read the payment fresh (rather than
                // spreading the patch) so orders reflects whichever concurrent
                // delivery won, including when our own write matched 0 rows.
                const { data: fresh } = await db
                  .from('race_payments')
                  .select('*')
                  .eq('id', payment.id)
                  .maybeSingle()
                if (fresh) await syncOrderFromRacePayment({ db, payment: fresh })
              }
            }
          }
        }
      } catch (e) {
        logError('stripe-webhook', 'charge.refunded sync failed', {
          err: e,
          chargeId: event.data?.object?.id || null,
          account: event.account || null,
        })
      }
    }
    // charge.refunded is handled above (HOST-PORTAL.7). Payout events still
    // land in a follow-up slice — safely ignored (200) here.
  } catch (e) {
    // Logged, not surfaced: returning non-2xx would make Stripe retry + risk
    // auto-disabling the endpoint. The state will re-sync on the next event.
    logWarn('stripe-webhook', 'handler failed', { err: e, type: event?.type })
  }

  return NextResponse.json({ received: true })
}
