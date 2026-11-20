// GET /api/public/raffle-orders/[id] — RAFFLE.3: public, read-only status of
// one online raffle order, for the event page's embedded checkout and the
// `?raffle_order=<id>` return to poll. The UUID is the capability token.
// Display-safe fields only: no buyer name or email is returned.
//
// While the payment is pending it re-checks Revolut (rate-capped per order) so
// the page can advance before the webhook lands. Every observation of a paid
// order runs the stamp-keyed effects (tickets once, email once): that is what
// recovers a buyer whose webhook never landed. Once the tickets exist the
// answer carries their numbers.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { paymentsFor } from '@/lib/payments'
import { uuidLike } from '@/lib/schemas'
import { RAFFLE_ORDER_COLS, markRaffleOrderPaymentStatus, runPaidRaffleOrderEffects } from '@/lib/raffle-online'
import { checkRateLimit } from '@/lib/rate-limit'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

function publicState(row) {
  if (row.status === 'paid') return 'paid'
  if (row.status === 'failed' || row.status === 'expired') return 'failed'
  if (row.status === 'refunded') return 'refunded'
  return 'pending'
}

export async function GET(_request, props) {
  const { id } = await props.params
  if (!uuidLike.safeParse(id).success) return notFound()
  const db = createServerClient()
  const read = () => db.from('raffle_orders').select(RAFFLE_ORDER_COLS).eq('id', id).maybeSingle()
  const { data, error } = await read()
  if (error || !data) return notFound()
  let row = data

  const canRecheck = row.status === 'awaiting_payment' && row.payment_provider === 'revolut' && !!row.payment_provider_ref
  const recheckAllowed = canRecheck
    ? (await checkRateLimit(db, `rpoll:${id}`, { max: 100, windowMs: 5 * 60_000 })).allowed
    : false
  if (recheckAllowed) {
    try {
      const norm = await paymentsFor('revolut').getPayment(row.payment_provider_ref, {})
      if (norm) {
        await markRaffleOrderPaymentStatus({
          db, order: row, providerState: norm.state,
          providerAmount: Number.isFinite(norm.amountCents) ? norm.amountCents : null,
        })
        const { data: fresh, error: rereadErr } = await read()
        if (rereadErr) logWarn('raffle-poll', 're-read after mark failed', { err: rereadErr, orderId: id })
        if (fresh) row = fresh
      }
    } catch (e) { logWarn('raffle-poll', 're-check failed', { err: e, orderId: id }) }
  }

  let tickets = null
  if (row.status === 'paid') {
    const effects = await runPaidRaffleOrderEffects({ db, order: row })
    if (effects.sale) tickets = { first: effects.sale.first_ticket, last: effects.sale.last_ticket }
  }

  const awaiting = row.status === 'awaiting_payment' && !!row.payment_provider_ref
  return NextResponse.json({ success: true, data: {
    id: row.id,
    state: publicState(row),
    paid: row.status === 'paid',
    quantity: row.quantity,
    amount_cents: row.amount_cents,
    currency: row.currency,
    tickets,
    checkout: awaiting
      ? { provider: row.payment_provider, token: row.payment_checkout_token, url: row.payment_checkout_url, connectedAccountId: null }
      : null,
  } })
}
