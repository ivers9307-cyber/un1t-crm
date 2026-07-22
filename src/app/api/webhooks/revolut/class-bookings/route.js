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

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import { resolveClassBookingPaymentByRef, markClassBookingPaymentStatus } from '@/lib/class-booking-payments'
import { publishQueuePush, CLASS_BOOKINGS_WORKER_PATH } from '@/lib/qstash'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { logWarn } from '@/lib/log'

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

  // Idempotency (mig 107 pattern). Distinct provider key from the
  // race webhook so a single (order, state) pair can't collide
  // across the two routes.
  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.REVOLUT_CLASS_BOOKING,
    eventId: `${event}:${orderId}`,
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  const row = await resolveClassBookingPaymentByRef(db, orderId)
  if (!row) {
    // Could be a misrouted webhook from another Revolut flow, or a
    // stale id. Return 200 so Revolut moves on.
    logWarn('classbook-webhook', `no class_booking_requests row for order ${orderId}`, { event })
    return NextResponse.json({ success: true, skipped: 'unknown_order' })
  }

  // Refresh authoritative state from Revolut (webhook payload omits
  // amount on some events).
  let order
  try {
    order = await getOrder(orderId)
  } catch (e) {
    logWarn('classbook-webhook', `getOrder failed for ${orderId}`, { err: e })
    return NextResponse.json({ success: true, deferred: true })
  }
  if (!order) return NextResponse.json({ success: true, skipped: 'order_missing' })

  const state = String(order.state || '').toLowerCase()
  const { released } = await markClassBookingPaymentStatus({
    db,
    request: row,
    providerState: state,
    providerAmount: Number.isFinite(order.amount) ? order.amount : null,
  })

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
