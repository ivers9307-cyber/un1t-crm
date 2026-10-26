// POST /api/webhooks/revolut/class-bookings
//
// SEPARATE Revolut webhook receiver for PAID class-funnel bookings.
// Configure this URL as its own webhook endpoint in the Revolut
// Business dashboard (or filter the existing one by metadata).
// Mirrors /api/webhooks/revolut/race-payments — same signature-verify
// → dedupe → resolve → getOrder → mark shape, just a different
// domain and payment-lifecycle helper (class-booking-payments.js
// instead of race-payments.js).
//
// On a paid order this releases the held booking (status→'queued')
// so the existing /api/cron/process-class-bookings processor grants
// the block's Glofox product + books the class. Idempotent via
// webhook_events (provider REVOLUT_CLASS_BOOKING) plus the payment
// row's own status guard in markClassBookingPaymentStatus; returns
// 200 on anything unrecognised so Revolut doesn't auto-disable the
// hook.
//
// Auth: each Revolut webhook gets its OWN signing secret. We try
// REVOLUT_CLASS_BOOKING_WEBHOOK_SECRET first (the dedicated one for
// this webhook), falling back to REVOLUT_WEBHOOK_SECRET for the
// transition window or single-merchant-account setups.
//
// REVPAY.1 — resolve FIRST (class booking, then trial purchase), claim
// second: every endpoint on the merchant account receives every order's
// events, so another flow's order answers 200 skipped with no dedupe row and
// no log line. After the claim, a deferral (getOrder throws, the status write
// fails) releases the claim and answers 200 { deferred } — the donations
// route's pattern — so an ops resend from the Revolut dashboard is processed.
// Nothing after a mark that landed releases it (the queue nudge is
// best-effort; the row's status is the guarantee).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import { resolveClassBookingPaymentByRef, markClassBookingPaymentStatus } from '@/lib/class-booking-payments'
import { resolveTrialPurchaseByRef, markTrialPurchasePaymentStatus } from '@/lib/trial-purchase-payments'
import { publishQueuePush, CLASS_BOOKINGS_WORKER_PATH, TRIAL_PURCHASES_WORKER_PATH } from '@/lib/qstash'
import { recordWebhookEvent, releaseWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'

export async function POST(request) {
  const rawBody = await request.text()
  const sig = request.headers.get('revolut-signature')
  const ts = request.headers.get('revolut-request-timestamp')
  // Class-booking webhook secret, with the cars/shared one as a
  // fallback so pre-split deployments still verify.
  const secrets = [
    process.env.REVOLUT_CLASS_BOOKING_WEBHOOK_SECRET,
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

  // Resolve before claiming. A failed read is not "not ours": defer (nothing
  // is claimed yet, so there is nothing to release).
  let row = null
  let trial = null
  try {
    row = await resolveClassBookingPaymentByRef(db, orderId, { throwOnError: true })
    // PAIDTRIAL.1 — the same Revolut endpoint settles paid trial purchases
    // (one merchant account, one webhook URL; no dashboard change).
    if (!row) trial = await resolveTrialPurchaseByRef(db, orderId, { throwOnError: true })
  } catch (e) {
    logWarn('classbook-webhook', 'payment row lookup failed; deferred', { err: e, orderId, event })
    return NextResponse.json({ success: true, deferred: true })
  }
  if (!row && !trial) {
    // Another flow's order (races, cars, offers, donations) or a stale id.
    // Normal traffic, so no log; 200 so Revolut moves on.
    return NextResponse.json({ success: true, skipped: 'unknown_order' })
  }

  // Idempotency (mig 107 pattern). Distinct provider key from the
  // race webhook so a single (order, state) pair can't collide
  // across the two routes. Taken before any write: two deliveries of the same
  // (event, order) still serialise on this insert.
  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.REVOLUT_CLASS_BOOKING,
    eventId,
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  // Give the claim back and answer 200.
  const defer = async () => {
    await releaseWebhookEvent({ db, provider: WEBHOOK_PROVIDERS.REVOLUT_CLASS_BOOKING, eventId })
    return NextResponse.json({ success: true, deferred: true })
  }

  // Refresh authoritative state from Revolut (webhook payload omits
  // amount on some events).
  const scope = trial ? 'trialbuy-webhook' : 'classbook-webhook'
  let order
  try {
    order = await getOrder(orderId)
  } catch (e) {
    logWarn(scope, `getOrder failed for ${orderId}`, { err: e })
    return await defer()
  }
  if (!order) return NextResponse.json({ success: true, skipped: 'order_missing' })
  const providerState = String(order.state || '').toLowerCase()
  const providerAmount = Number.isFinite(order.amount) ? order.amount : null

  if (trial) {
    let released
    try {
      // Throws on a failed status write.
      ({ released } = await markTrialPurchasePaymentStatus({ db, purchase: trial, providerState, providerAmount }))
    } catch (e) {
      logError(scope, `trial purchase status write failed for order ${orderId}; deferred`, { err: e, purchaseId: trial.id })
      return await defer()
    }
    if (released) {
      try { await publishQueuePush({ path: TRIAL_PURCHASES_WORKER_PATH, body: { id: trial.id }, deduplicationId: `trial-purchase-${trial.id}` }) } catch { /* queue is the guarantee */ }
    }
    return NextResponse.json({ success: true, released, domain: 'trial_purchase' })
  }

  let marked
  try {
    marked = await markClassBookingPaymentStatus({ db, request: row, providerState, providerAmount })
  } catch (e) {
    logError(scope, `class booking mark threw for order ${orderId}; deferred`, { err: e, requestId: row.id })
    return await defer()
  }
  if (marked?.error) {
    // The status write failed: the booking is still held. Defer so a resend
    // or the status poll's re-check applies it.
    logError(scope, `class booking status write failed for order ${orderId}; deferred`, { err: marked.error, requestId: row.id })
    return await defer()
  }
  const released = marked?.released === true

  if (released) {
    // Nudge QStash to deliver this row to the processor now instead
    // of waiting for the next cron tick. Fire-and-forget: any
    // failure leaves the row for the cron — the queue table (row
    // status='queued') is the delivery guarantee, not this push.
    try {
      await publishQueuePush({
        path: CLASS_BOOKINGS_WORKER_PATH,
        body: { id: row.id },
        deduplicationId: `class-booking-${row.id}`,
      })
    } catch {
      // publishQueuePush swallows its own errors; belt-and-braces only.
    }
  }

  return NextResponse.json({ success: true, released })
}

// Revolut hits GET when configuring the webhook URL — return 200 so
// they consider it valid.
export async function GET() {
  return NextResponse.json({ success: true, ok: 'class-bookings revolut webhook endpoint' })
}
