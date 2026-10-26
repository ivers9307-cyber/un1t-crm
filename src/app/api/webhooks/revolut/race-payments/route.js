// POST /api/webhooks/revolut/race-payments
//
// SEPARATE Revolut webhook receiver for race payments. Configure
// this URL as a SECOND webhook endpoint in the Revolut Business
// dashboard (or filter the existing one by metadata).
//
// Why separate from /api/webhooks/revolut (cars)?
//   1. Different domain (UN1T vs CCF Autos) — having distinct URLs
//      makes per-business observability + signing-key rotation
//      possible without entangling the two flows.
//   2. The existing handler does cars-only work (deposit_status
//      mutations, deposit-receipt SMS). Forcing it to dispatch on
//      payload.metadata.domain would couple two unrelated business
//      lifecycles in one route.
//
// Operationally: both URLs are valid and Revolut will deliver the
// event to whichever webhook subscribed to it. The order's metadata
// (domain 'un1t_race', or 'un1t_race_gap' for a price difference) is
// NOT checked here: the guard is the lookup itself, since an order id
// with no race_payments row returns 200/skipped and mutates nothing.
//
// Auth: each Revolut webhook gets its OWN signing secret. We try
// REVOLUT_RACE_WEBHOOK_SECRET first (the dedicated one for this
// webhook), falling back to REVOLUT_WEBHOOK_SECRET for the
// transition window or single-merchant-account setups. Both are
// passed to verifyWebhookSignature; whichever matches the header
// candidate wins.
//
// REVPAY.1 — resolve FIRST, claim second. Every Revolut webhook endpoint
// receives every event for every order on the merchant account, so most
// deliveries here are for another flow's order: those now answer 200
// skipped without a dedupe row or a log line. Once the order is ours the
// (event, order) key is claimed, and every path that DEFERS after the claim
// (getOrder throws, the status write fails) releases it and answers
// 200 { deferred }, so an ops resend from the Revolut dashboard is processed
// instead of being answered 'deduped' (the donations route's pattern). After a
// mark that landed, nothing releases the claim: the confirmations and the
// Glofox push are best-effort and must never run twice.

import { NextResponse, after } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import { resolveRacePaymentByProviderRef, markRacePaymentStatus } from '@/lib/race-payments'
import { runRacePaymentCompletedEffects } from '@/lib/race-payment-completed'
import { recordWebhookEvent, releaseWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'

export async function POST(request) {
  const rawBody = await request.text()
  const sig = request.headers.get('revolut-signature')
  const ts = request.headers.get('revolut-request-timestamp')
  // Race webhook secret, with the cars/shared one as a fallback so
  // pre-split deployments still verify.
  const secrets = [
    process.env.REVOLUT_RACE_WEBHOOK_SECRET,
    process.env.REVOLUT_WEBHOOK_SECRET,
  ].filter(Boolean)
  if (!verifyWebhookSignature(rawBody, sig, ts, { secrets })) {
    return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 })
  }

  let payload = null
  try { payload = JSON.parse(rawBody) } catch {
    // Empty body during a verification ping — return 200.
    return NextResponse.json({ success: true })
  }

  const orderId = payload?.order_id
  const event = payload?.event
  if (!orderId || !event) return NextResponse.json({ success: true })

  const db = createServerClient()
  const eventId = `${event}:${orderId}`

  // Resolve before claiming (see the header): an order that is not ours takes
  // no dedupe row. A failed read is not "not ours": defer (nothing claimed yet).
  let payment
  try {
    payment = await resolveRacePaymentByProviderRef(db, orderId, { throwOnError: true })
  } catch (e) {
    logWarn('revolut-race-webhook', 'race_payments lookup failed; deferred', { err: e, orderId, event })
    return NextResponse.json({ success: true, deferred: true })
  }
  if (!payment) {
    // Another flow's order (cars, class bookings, offers, donations) or a
    // stale id. Normal traffic, so no log; 200 so Revolut moves on.
    return NextResponse.json({ success: true, skipped: 'unknown_order' })
  }

  // Idempotency (mig 107). Distinct provider key from the cars
  // Revolut webhook so a single (order, state) pair can't collide
  // across the two routes. Taken after the resolve, before any write: two
  // deliveries of the same (event, order) still serialise on this insert.
  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.REVOLUT_RACE,
    eventId,
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  // Give the claim back and answer 200.
  const defer = async () => {
    await releaseWebhookEvent({ db, provider: WEBHOOK_PROVIDERS.REVOLUT_RACE, eventId })
    return NextResponse.json({ success: true, deferred: true })
  }

  // Refresh authoritative state from Revolut (webhook payload omits
  // amount on some events).
  let order
  try {
    order = await getOrder(orderId)
  } catch (e) {
    logWarn('revolut-race-webhook', `getOrder failed for ${orderId}`, { err: e })
    return await defer()
  }
  if (!order) return NextResponse.json({ success: true, skipped: 'order_missing' })

  const state = String(order.state || '').toLowerCase()
  let result
  try {
    result = await markRacePaymentStatus({
      db,
      payment,
      revolutState: state,
      revolutAmount: Number.isFinite(order.amount) ? order.amount : null,
    })
  } catch (e) {
    logError('revolut-race-webhook', `mark failed for order ${orderId}`, { err: e, paymentId: payment.id })
    return await defer()
  }
  // The status write failed (markRacePaymentStatus logged it): nothing was
  // applied, so release and let a resend or the return-page refresh apply it.
  if (result?.error) return await defer()

  // On a fresh completion: the entry confirmations + Glofox push, or the gap
  // receipt for a price difference (EVENT-MOVE.5), never both. Shared with
  // the reconcile cron (src/lib/race-payment-completed.js, REVPAY.3).
  // after(): the Glofox push runs once the response is sent, and Vercel keeps
  // the function alive until it finishes (a floating promise could be cut off
  // when the response returned).
  const { confirmations, glofoxPush } = await runRacePaymentCompletedEffects({ db, payment, applied: result.applied })
  if (glofoxPush) after(glofoxPush)

  return NextResponse.json({
    success: true,
    applied: result.applied,
    confirmations,
  })
}

// Revolut hits GET when configuring the webhook URL — return 200 so
// they consider it valid.
export async function GET() {
  return NextResponse.json({ success: true, ok: 'race-payments revolut webhook endpoint' })
}
