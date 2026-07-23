// class-booking-payments — payment lifecycle for a PAID class-funnel intro.
//
// Mirrors race-payments.js (same dispatcher, same webhook-driven state machine)
// but keyed on a class_booking_requests row. DELIBERATELY separate from
// race-payments: different domain, different confirmation side-effects. The only
// shared code is the payments dispatcher (processor-agnostic transport).
//
// Lifecycle: the public booking route inserts the row `awaiting_payment`, then
// createClassBookingPayment() opens a provider order and stamps the refs.
// The signed webhook (or the poll route's re-check) calls
// markClassBookingPaymentStatus(): 'paid' RELEASES the booking (status→'queued')
// so the existing processor grants the block's product + books; 'failed'/
// 'expired' are terminal (no booking, money not taken).
import { paymentsFor } from './payments'
import { resolveLocationPaymentProvider } from './location-payments'
import { getAppUrl } from './app-url'

/**
 * Open a provider payment for an already-inserted `awaiting_payment` row and
 * persist the provider refs on it. amountCents is the SERVER-derived block
 * price — never a client value. Returns the checkout handle for the caller.
 */
export async function createClassBookingPayment({ db, request, location, amountCents, currency }) {
  const { provider, connectedAccountId } = resolveLocationPaymentProvider(location)
  const created = await paymentsFor(provider).createPayment({
    amountCents,
    currency: currency || 'EUR',
    description: `UN1T intro — ${request.class_name || 'class'}`,
    returnUrl: `${getAppUrl()}/class-pay/${request.id}`,
    metadata: { class_booking_request_id: request.id, domain: 'un1t_class_booking' },
    idempotencyKey: request.id,
    connectedAccountId,
    applicationFeeCents: 0,
  })
  // The provider order is now open. Persisting its ref is REQUIRED — the webhook
  // and poll route find the booking by payment_provider_ref. If this write fails
  // we must NOT hand back a checkout URL (the customer could pay against a row
  // nothing can ever release); throw so the caller returns an error and this
  // unpaid order simply expires.
  const { error: refErr } = await db.from('class_booking_requests')
    .update({
      payment_status: 'pending',
      payment_provider: provider,
      payment_provider_ref: created.providerRef,
      payment_checkout_token: created.checkoutToken || null,
      payment_checkout_url: created.checkoutUrl || null,
      amount_cents: amountCents,
      currency: currency || 'EUR',
      connected_account_id: connectedAccountId || null,
    })
    .eq('id', request.id)
  if (refErr) {
    throw new Error(`Failed to persist payment ref for booking ${request.id}: ${refErr.message}`)
  }
  return {
    paymentId: request.id,
    checkout: {
      provider,
      token: created.checkoutToken || null,
      url: created.checkoutUrl || null,
      connectedAccountId,
    },
  }
}

/** Webhook lookup: the row that owns this provider order. */
export async function resolveClassBookingPaymentByRef(db, providerRef) {
  if (!providerRef) return null
  const { data } = await db.from('class_booking_requests')
    .select('*').eq('payment_provider_ref', providerRef).maybeSingle()
  return data || null
}

/**
 * Apply a provider state change. `providerState` is the adapter's lowercased
 * state ('completed'|'failed'|'cancelled'|'expired'|transient…).
 * Returns { released } — true when this call moved the booking to 'queued'.
 */
export async function markClassBookingPaymentStatus({ db, request, providerState, providerAmount }) {
  if (request?.payment_status === 'paid') return { released: false }
  if (request?.payment_status === 'failed' || request?.payment_status === 'expired') return { released: false }

  const state = String(providerState || '').toLowerCase()
  if (state === 'completed') {
    const updates = { payment_status: 'paid' }
    if (Number.isFinite(providerAmount) && providerAmount !== request.amount_cents) updates.amount_cents = providerAmount
    if (request.status === 'awaiting_payment') updates.status = 'queued'
    await db.from('class_booking_requests').update(updates).eq('id', request.id)
    return { released: updates.status === 'queued' }
  }
  if (state === 'failed' || state === 'cancelled' || state === 'expired') {
    const payment_status = state === 'cancelled' ? 'expired' : state
    await db.from('class_booking_requests')
      .update({ payment_status, status: 'payment_failed' })
      .eq('id', request.id)
    return { released: false }
  }
  return { released: false }
}
