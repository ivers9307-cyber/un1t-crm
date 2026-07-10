// GET /api/host/stripe/payouts — the logged-in host's Stripe balance + recent
// payouts (HOST-PORTAL.12). Read-only visibility: platform-key calls made ON
// BEHALF OF the host's connected account via the `stripeAccount` request
// option (Standard accounts, direct charges — the money lives on THEIR
// account, not ours).
//
// Graceful-degrade by design: non-Stripe hosts, hosts without a connected
// account, and ANY Stripe error (Stripe down, account revoked platform access
// — Standard accounts can do that at will) all return `{ success:true,
// data:null }`, never a 5xx. The portal renders nothing rather than breaking.

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { getStripe } from '@/lib/stripe'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Sum a Stripe balance bucket (`available` / `pending` — arrays of
 * `{ amount, currency }`, one entry per currency+source) for one currency.
 */
function sumForCurrency(entries, currency) {
  return (entries || [])
    .filter((e) => e && e.currency === currency)
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0)
}

export async function GET() {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { payment_provider: provider, stripe_connected_account_id: accountId } = session.host
  // Not a Stripe-Connect host (Revolut/internal) or not yet onboarded — there
  // is no Stripe settlement to show. Deliberately NOT an error.
  if (provider !== 'stripe_connect' || !accountId) {
    return NextResponse.json({ success: true, data: null })
  }

  try {
    const stripe = getStripe()
    const opts = { stripeAccount: accountId }
    const [balance, payouts] = await Promise.all([
      stripe.balance.retrieve(undefined, opts),
      stripe.payouts.list({ limit: 10 }, opts),
    ])

    // A balance can hold several currencies; the portal shows one. Take the
    // first currency Stripe reports (available first, else pending) and sum
    // that currency's entries in both buckets.
    const currency =
      balance?.available?.[0]?.currency || balance?.pending?.[0]?.currency || 'eur'

    return NextResponse.json({
      success: true,
      data: {
        balance: {
          available_cents: sumForCurrency(balance?.available, currency),
          pending_cents: sumForCurrency(balance?.pending, currency),
          currency,
        },
        payouts: (payouts?.data || []).map((p) => ({
          id: p.id,
          amount: p.amount,
          currency: p.currency,
          status: p.status,
          arrival_date: p.arrival_date,
          created: p.created,
        })),
      },
    })
  } catch (err) {
    // Never break the portal over Stripe: log and degrade to "no data".
    logError('host-payouts', 'Stripe balance/payouts read failed', {
      host_id: session.host.id,
      error: err?.message,
    })
    return NextResponse.json({ success: true, data: null })
  }
}
