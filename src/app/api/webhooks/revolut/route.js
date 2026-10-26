// POST /api/webhooks/revolut
//
// Revolut Merchant webhook receiver. Configure the URL in your
// Revolut Business dashboard → APIs → Merchant API → Webhooks, then
// store the returned signing secret as REVOLUT_WEBHOOK_SECRET.
//
// Auth: HMAC-SHA256 over `v1.<timestamp>.<raw_body>` using the
// signing secret. Multiple `v1=<hex>` values may be present in the
// header during a secret rotation; any one matching is acceptable.
// Replay window enforced at ±5 minutes inside verifyWebhookSignature.
//
// Payload shape (truncated):
//   {
//     event: 'ORDER_COMPLETED' | 'ORDER_AUTHORISED' | 'ORDER_PAYMENT_DECLINED' | ...
//     order_id: '<uuid>',
//     ...
//   }
//
// We trust two things:
//   (a) the signature
//   (b) the order_id (looked up against cars.deposit_revolut_order_id)
// Everything else (state, amount, etc) is fetched fresh via
// getOrder() — payload metadata can be stale or omitted.
//
// REVPAY.1 — resolve FIRST, claim second: every endpoint on the merchant
// account receives every order's events, so an order with no car answers 200
// skipped with no dedupe row and no log line. After the claim, a deferral
// (getOrder throws, the cars write fails) releases the claim and answers
// 200 { deferred }, the donations route's pattern, so an ops resend from the
// Revolut dashboard is processed rather than answered 'deduped'. The orders
// sync, events and sequences after a write that landed never release it.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import { recordWebhookEvent, releaseWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { depositUpdateForOrder, applyCarDepositUpdates } from '@/lib/car-deposit-revolut'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'

// The state mapping, the deposit write and its side effects live in
// src/lib/car-deposit-revolut.js (REVPAY.3), shared with the reconcile cron.
export { depositUpdateForOrder }

export async function POST(request) {
  const rawBody = await request.text()
  const sig = request.headers.get('revolut-signature')
  const ts = request.headers.get('revolut-request-timestamp')
  if (!verifyWebhookSignature(rawBody, sig, ts)) {
    return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 })
  }

  let payload = null
  try { payload = JSON.parse(rawBody) } catch {
    // Empty body during a verification ping — return 200 so Revolut
    // doesn't disable the hook.
    return NextResponse.json({ success: true })
  }

  const orderId = payload?.order_id
  const event = payload?.event
  if (!orderId || !event) return NextResponse.json({ success: true })

  const db = createServerClient()
  const eventId = `${event}:${orderId}`

  // REVOLUT.1 — buyer_email, deposit_revolut_order_id and
  // deposit_link_sent_at are read by the orders sync and the buyer-contact
  // branch below. buyer_email was missing from this select until REVOLUT.1,
  // so both were dead in production (syncOrderFromCarDeposit returns null
  // without it, and the `car.buyer_email` guard never passed).
  // REVPAY.1 — resolved before the claim; a failed read defers (nothing is
  // claimed yet) instead of reading as "not ours".
  const { data: car, error: carReadErr } = await db
    .from('cars')
    .select(`
      id, location_id, deposit_token, deposit_status, deposit_paid_at,
      deposit_amount, deposit_paid_amount,
      deposit_revolut_order_id, deposit_link_sent_at,
      buyer_email, buyer_phone, buyer_name, make, model, irish_reg,
      locations ( id, name )
    `)
    .eq('deposit_revolut_order_id', orderId)
    .maybeSingle()
  if (carReadErr) {
    logWarn('revolut-webhook', 'cars lookup failed; deferred', { err: carReadErr, orderId, event })
    return NextResponse.json({ success: true, deferred: true })
  }
  if (!car) {
    // Another flow's order on the same merchant account (races, class
    // bookings, offers, donations) or a stale id. Normal traffic, so no
    // log; 200 so Revolut moves on.
    return NextResponse.json({ success: true, skipped: 'unknown_order' })
  }

  // Idempotency (mig 107). Revolut sends ORDER_AUTHORISED then
  // ORDER_COMPLETED for the same order; we want to process each
  // event-state once, but a retry of either should short-circuit.
  // Per-row guards still exist downstream — this is the chokepoint.
  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.REVOLUT,
    eventId,
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  // Give the claim back and answer 200.
  const defer = async () => {
    await releaseWebhookEvent({ db, provider: WEBHOOK_PROVIDERS.REVOLUT, eventId })
    return NextResponse.json({ success: true, deferred: true })
  }

  // Fetch the live order — gives us authoritative state + actual
  // captured amount, regardless of whether the webhook payload
  // included that detail.
  let order = null
  try {
    order = await getOrder(orderId)
  } catch (e) {
    logWarn('revolut-webhook', `getOrder failed for ${orderId}`, { err: e })
    return await defer()
  }
  if (!order) return NextResponse.json({ success: true, skipped: 'order_missing' })

  // Order states per Revolut Merchant API spec (merchant-2026-03-12.yaml,
  // schema Order-State): pending, processing, authorised, completed,
  // cancelled, failed. We flip our deposit_status only on terminal
  // states. Note: there is NO 'refunded' order state — refunds create
  // a NEW order with type=refund linked via related_order_id; the
  // original order's state stays 'completed'. Refund handling would
  // need a separate flow (not webhook-driven) if we ever build it.
  // Map the authoritative order state → cars-deposit updates (pure; see
  // depositUpdateForOrder). Terminal states only; transient ones ignore-and-200.
  const { state, updates } = depositUpdateForOrder({ order, car })
  if (!updates) {
    return NextResponse.json({ success: true, ignored_state: state })
  }
  // Write + orders ledger + contact event + order_* sequences
  // (src/lib/car-deposit-revolut.js; the reconcile cron runs the same).
  // REVPAY.1 — a failed deposit write runs no side effect and defers: the
  // claim made it final otherwise.
  const { error: carWriteErr } = await applyCarDepositUpdates({ db, car, order, state, updates })
  if (carWriteErr) {
    logError('revolut-webhook', 'cars deposit write failed; deferred', { err: carWriteErr, carId: car.id, orderId, state })
    return await defer()
  }

  // The buyer receipt SMS (mig 078) was retired with Twilio
  // (TWILIO-RETIRE.1); the public deposit page shows the paid receipt.
  return NextResponse.json({ success: true, applied: updates })
}

// Revolut dashboard hits GET on the URL when configuring the
// webhook — return 200 so it considers the URL valid.
export async function GET() {
  return NextResponse.json({ success: true, ok: 'revolut webhook endpoint' })
}
