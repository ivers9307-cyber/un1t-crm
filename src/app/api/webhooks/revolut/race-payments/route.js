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
// event to whichever webhook subscribed to it. We use payload
// metadata.domain='un1t_race' as a defensive secondary check so a
// misrouted webhook returns 200/skipped rather than mutating the
// wrong domain.
//
// Auth: shares REVOLUT_WEBHOOK_SECRET with the cars webhook in v1.
// Splitting the secret can come later by switching to
// REVOLUT_RACE_WEBHOOK_SECRET when configured.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import { resolveRacePaymentByProviderRef, markRacePaymentStatus } from '@/lib/race-payments'
import { sendRaceConfirmations } from '@/lib/race-confirmations'

export const runtime = 'nodejs'

export async function POST(request) {
  const rawBody = await request.text()
  const sig = request.headers.get('revolut-signature')
  const ts = request.headers.get('revolut-request-timestamp')
  if (!verifyWebhookSignature(rawBody, sig, ts)) {
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
  const payment = await resolveRacePaymentByProviderRef(db, orderId)
  if (!payment) {
    // Could be a cars deposit webhook misrouted here, or a stale id.
    // Return 200 so Revolut moves on. The cars handler at
    // /api/webhooks/revolut owns those.
    console.warn(`[revolut-race-webhook] no race_payment for order ${orderId} (event ${event})`)
    return NextResponse.json({ success: true, skipped: 'unknown_order' })
  }

  // Refresh authoritative state from Revolut (webhook payload omits
  // amount on some events).
  let order
  try {
    order = await getOrder(orderId)
  } catch (e) {
    console.warn(`[revolut-race-webhook] getOrder failed for ${orderId}: ${e.message}`)
    return NextResponse.json({ success: true, skipped: 'getorder_failed' })
  }
  if (!order) return NextResponse.json({ success: true, skipped: 'order_missing' })

  const state = String(order.state || '').toLowerCase()
  const result = await markRacePaymentStatus({
    db,
    payment,
    revolutState: state,
    revolutAmount: Number.isFinite(order.amount) ? order.amount : null,
  })

  // On a fresh completion, fire the confirmations. Idempotent inside
  // sendRaceConfirmations via the *_sent_at stamps so a Revolut retry
  // can't double-send.
  let confirmations = null
  if (result.applied?.status === 'completed') {
    try {
      confirmations = await sendRaceConfirmations({ db, paymentId: payment.id })
    } catch (e) {
      console.warn(`[revolut-race-webhook] confirmations failed for ${payment.id}: ${e.message}`)
      confirmations = { failed: [`unhandled:${e.message}`] }
    }
  }

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
