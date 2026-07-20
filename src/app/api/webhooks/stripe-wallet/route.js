// INTEG-C2b — POST /api/webhooks/stripe-wallet: dedicated Stripe
// webhook for WALLET TOP-UPS (plain platform charges).
//
// Deliberately a SEPARATE endpoint from /api/webhooks/stripe (the
// Connect/events endpoint) with its OWN signing secret
// (STRIPE_WALLET_WEBHOOK_SECRET, no fallback): register a second
// endpoint in the Stripe dashboard pointing here with ONLY
// checkout.session.completed + checkout.session.expired, WITHOUT
// "listen to events on connected accounts". Until the secret is set in
// the environment the endpoint answers 503 + an error-level log —
// safely inert, and a misrouted delivery can never be verified against
// the wrong secret.
//
// Idempotent end to end: fulfillTopup's pending→paid claim UPDATE is
// guarded on status (a replayed completed event credits nothing), and
// the expired transition is guarded the same way (can never regress a
// paid invoice). Returns 200 for handled AND unrecognised events so
// Stripe doesn't auto-disable the endpoint; a bad signature is the
// only 400. Handler errors are logged, not surfaced (the events-
// webhook posture — non-2xx risks endpoint auto-disable).

import { NextResponse } from 'next/server'
import { verifyStripeWalletWebhook, isStripeWalletWebhookConfigured } from '@/lib/stripe'
import { createServerClient } from '@/lib/supabase'
import { fulfillTopup, markTopupSessionExpired } from '@/lib/wallet-topup'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  // No secret configured → loud 503, no verification attempt. This is
  // what keeps the endpoint safely inert until the operator creates
  // the Stripe endpoint and sets the env var (PR-body checklist).
  if (!isStripeWalletWebhookConfigured()) {
    logError('stripe-wallet-webhook', 'STRIPE_WALLET_WEBHOOK_SECRET is not set — endpoint inert, delivery refused', {})
    return NextResponse.json(
      { success: false, error: 'Wallet webhook is not configured' },
      { status: 503 }
    )
  }

  const signature = request.headers.get('stripe-signature') || ''
  let event
  try {
    const rawBody = await request.text()
    event = verifyStripeWalletWebhook(rawBody, signature)
  } catch (e) {
    return NextResponse.json(
      { success: false, error: `Invalid Stripe signature: ${e.message || 'unknown'}` },
      { status: 400 }
    )
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const db = createServerClient()
      await fulfillTopup(db, event.data.object)
    } else if (event.type === 'checkout.session.expired') {
      const db = createServerClient()
      await markTopupSessionExpired(db, event.data.object)
    }
    // Anything else (incl. async_payment_* — cards are the only enabled
    // method) falls through to the 200 below, per the repo invariant.
  } catch (e) {
    // Logged, not surfaced: returning non-2xx would make Stripe retry
    // and risk auto-disabling the endpoint. fulfillTopup already logs
    // the money-critical states (paid-but-not-credited) at error level.
    logWarn('stripe-wallet-webhook', 'handler failed', { err: e, type: event?.type })
  }

  return NextResponse.json({ received: true })
}
