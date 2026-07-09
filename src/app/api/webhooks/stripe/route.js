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
import { sendRaceConfirmations } from '@/lib/race-confirmations'
import { refundPatchFromCharge } from '@/lib/stripe-refund-sync'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
      const payment = await resolveRacePaymentByProviderRef(db, session.id)
      if (payment) {
        const result = await markRacePaymentStatus({
          db,
          payment,
          revolutState: 'completed',
          revolutAmount: Number.isFinite(session.amount_total) ? session.amount_total : null,
        })
        if (result.applied?.status === 'completed') {
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
      const payment = await resolveRacePaymentByProviderRef(db, session.id)
      if (payment) {
        await markRacePaymentStatus({ db, payment, revolutState: 'cancelled', revolutAmount: null })
      }
    } else if (event.type === 'charge.refunded') {
      // A refund issued Stripe-side (host dashboard refund or a dispute) never
      // hits our staff refund route, so sync it into race_payments here or
      // aggregateHostRevenue silently overstates. Direct charges live on the
      // CONNECTED account, so the checkout-session lookup must be scoped via
      // stripeAccount: event.account. Own try/catch: a sync failure is logged
      // at error level but still 200s (Stripe re-delivers charge.refunded on
      // later refunds, and the absolute write self-heals).
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
        const payment = session ? await resolveRacePaymentByProviderRef(db, session.id) : null
        if (!session || !payment) {
          // Recognised but unmatched (e.g. a charge outside the events
          // platform) — log it and fall through to the 200 below.
          logError('stripe-webhook', 'charge.refunded: no matching race_payment', {
            chargeId: charge.id,
            account: event.account || null,
          })
        } else {
          const patch = refundPatchFromCharge(charge, payment, new Date().toISOString())
          if (patch) await db.from('race_payments').update(patch).eq('id', payment.id)
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
