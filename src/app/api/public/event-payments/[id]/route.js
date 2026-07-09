// GET /api/public/event-payments/[id]
//
// Public — no auth. Read-only status of a single race_payments row.
// Used by:
//   - The embedded checkout page (/event-pay/[paymentId]) to render
//     the Revolut SDK, then poll after the buyer completes payment.
//   - The post-payment confirmation page (/race/[slug]/confirmed)
//     to show the right state if the buyer arrives before the
//     webhook lands.
//
// Privacy: returns ONLY the fields the browser needs to drive the
// checkout UI. No contact emails or phone numbers. The id itself is
// a UUID — knowing it shouldn't leak material information.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { refreshRacePaymentFromProvider } from '@/lib/race-payments'

export const runtime = 'nodejs'

export async function GET(_request, props) {
  const params = await props.params;
  const db = createServerClient()
  const { data, error } = await db
    .from('race_payments')
    .select(`
      id, status, amount_cents, currency,
      payment_provider, payment_provider_ref,
      payment_checkout_token, payment_checkout_url, connected_account_id,
      application_fee_cents,
      race_event_id, race_registration_id,
      race:race_event_id ( id, name, slug ),
      registration:race_registration_id ( id, status, team_id,
        teams:team_id ( name, size ) )
    `)
    .eq('id', params.id)
    .maybeSingle()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Payment not found' }, { status: 404 })
  }

  // If the front-end is asking and the payment is still pending,
  // refresh from the provider in case the webhook hasn't landed yet.
  // Side effect: markRacePaymentStatus may update the row inline.
  let row = data
  if (
    data.status === 'pending' &&
    (data.payment_provider === 'revolut' || data.payment_provider === 'stripe_connect') &&
    data.payment_provider_ref
  ) {
    try {
      const refreshed = await refreshRacePaymentFromProvider(db, data)
      if (refreshed) {
        // Re-fetch the joined view since refresh only returns the bare row.
        const { data: re } = await db
          .from('race_payments')
          .select(`
            id, status, amount_cents, currency,
            payment_provider, payment_provider_ref,
            payment_checkout_token, payment_checkout_url,
            race_event_id, race_registration_id,
            race:race_event_id ( id, name, slug ),
            registration:race_registration_id ( id, status, team_id,
              teams:team_id ( name, size ) )
          `)
          .eq('id', params.id)
          .maybeSingle()
        if (re) row = re
      }
    } catch {
      // Refresh failures shouldn't break the read.
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      id: row.id,
      status: row.status,
      amount_cents: row.amount_cents,
      // The per-ticket booking fee UN1T adds on top (0/null for Revolut and
      // internal events). Ticket subtotal = amount_cents − booking_fee_cents.
      // Lets the checkout page itemise "what you're paying for" without the
      // buyer having to expand Stripe's collapsed "View details".
      booking_fee_cents: row.application_fee_cents || 0,
      currency: row.currency,
      provider: row.payment_provider,
      checkout: {
        // For Stripe embedded, `token` carries the Checkout Session
        // client_secret and `connected_account_id` is the host acct the
        // browser must init Stripe.js against (direct charge). For Revolut,
        // `token` is the order token and connected_account_id is null.
        token: row.payment_checkout_token,
        url: row.payment_checkout_url,
        connected_account_id: row.connected_account_id || null,
      },
      race: row.race,
      registration: row.registration
        ? {
            id: row.registration.id,
            status: row.registration.status,
            team_name: row.registration.teams?.name || null,
            team_size: row.registration.teams?.size || null,
          }
        : null,
    },
  })
}
