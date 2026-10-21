// GET /api/public/trial-purchases/[id] — PAIDTRIAL.1: public, read-only status
// of one trial purchase for the page's checkout and confirming states to poll.
// Display-safe fields only. While the payment is pending it re-checks the
// provider (rate-capped per purchase) so the UI can advance before the webhook
// lands; a settled payment releases the row and nudges the worker.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { paymentsFor } from '@/lib/payments'
import { markTrialPurchasePaymentStatus } from '@/lib/trial-purchase-payments'
import { trialPurchasePublicState } from '@/lib/paid-trial'
import { publishQueuePush, TRIAL_PURCHASES_WORKER_PATH } from '@/lib/qstash'
import { checkRateLimit } from '@/lib/rate-limit'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const COLS = 'id, status, payment_status, payment_provider, payment_provider_ref, payment_checkout_token, payment_checkout_url, amount_cents, currency, product_name, duration_days, connected_account_id'

export async function GET(_request, props) {
  const { id } = await props.params
  const db = createServerClient()
  const { data, error } = await db.from('trial_purchases').select(COLS).eq('id', id).maybeSingle()
  if (error || !data) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  let row = data
  const canRecheck = row.payment_status === 'pending'
    && (row.payment_provider === 'revolut' || row.payment_provider === 'stripe_connect')
    && row.payment_provider_ref
  const recheckAllowed = canRecheck
    ? (await checkRateLimit(db, `tppoll:${id}`, { max: 20, windowMs: 5 * 60_000 })).allowed
    : false
  if (recheckAllowed) {
    try {
      const norm = await paymentsFor(row.payment_provider).getPayment(row.payment_provider_ref, { connectedAccountId: row.connected_account_id || null })
      if (norm) {
        const { released } = await markTrialPurchasePaymentStatus({ db, purchase: row, providerState: norm.state, providerAmount: Number.isFinite(norm.amountCents) ? norm.amountCents : null })
        if (released) {
          try { await publishQueuePush({ path: TRIAL_PURCHASES_WORKER_PATH, body: { id: row.id }, deduplicationId: `trial-purchase-${row.id}` }) } catch { /* queue is the guarantee */ }
        }
        const { data: fresh } = await db.from('trial_purchases').select(COLS).eq('id', id).maybeSingle()
        if (fresh) row = fresh
      }
    } catch (e) { logWarn('trialbuy-poll', 're-check failed', { err: e }) }
  }

  return NextResponse.json({ success: true, data: {
    id: row.id,
    paid: row.payment_status === 'paid',
    state: trialPurchasePublicState(row),
    purchase_status: row.status,
    payment_status: row.payment_status,
    checkout: { provider: row.payment_provider, token: row.payment_checkout_token, url: row.payment_checkout_url },
    amount_cents: row.amount_cents, currency: row.currency, product_name: row.product_name, duration_days: row.duration_days,
  } })
}
