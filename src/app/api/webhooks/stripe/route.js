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
    }
    // Other event types (payment_intent, payout, charge.refunded) are handled
    // in the charge slice — safely ignored (200) here.
  } catch (e) {
    // Logged, not surfaced: returning non-2xx would make Stripe retry + risk
    // auto-disabling the endpoint. The state will re-sync on the next event.
    logWarn('stripe-webhook', 'handler failed', { err: e, type: event?.type })
  }

  return NextResponse.json({ received: true })
}
