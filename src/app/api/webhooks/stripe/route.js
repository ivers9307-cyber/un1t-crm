// POST /api/webhooks/stripe — Stripe Connect webhook (EVENTS-HOST.2).
//
// Register ONE endpoint in the Stripe dashboard pointing here, with "listen to
// events on connected accounts" enabled, so host account.updated (and later
// payout / payment_intent) events arrive. Its signing secret is
// STRIPE_WEBHOOK_SECRET.
//
// Signature-verified via verifyStripeWebhook (constructEvent) on the RAW body.
// Idempotent: account.updated is a state sync (applying the same account twice
// is harmless), so no dedup table is needed here. Always returns 200 for
// handled/unrecognised events so Stripe doesn't disable the endpoint; a bad
// signature is the only 4xx.

import { NextResponse } from 'next/server'
import { verifyStripeWebhook } from '@/lib/stripe'
import { createServerClient } from '@/lib/supabase'
import { resolveRacePaymentByProviderRef, markRacePaymentStatus } from '@/lib/race-payments'
import { sendRaceConfirmations } from '@/lib/race-confirmations'
import { logWarn } from '@/lib/log'

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
    }
    // Other event types (payout, charge.refunded) land in a follow-up slice —
    // safely ignored (200) here.
  } catch (e) {
    // Logged, not surfaced: returning non-2xx would make Stripe retry + risk
    // auto-disabling the endpoint. The state will re-sync on the next event.
    logWarn('stripe-webhook', 'handler failed', { err: e, type: event?.type })
  }

  return NextResponse.json({ received: true })
}
