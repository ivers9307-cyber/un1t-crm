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

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import { sendDepositReceiptSms } from '@/lib/deposit-receipts'
import { syncOrderFromCarDeposit } from '@/lib/orders'
import { emitEvent, EVENT_TYPES } from '@/lib/contact-events'

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
    // Empty body during a verification ping — return 200 so Revolut
    // doesn't disable the hook.
    return NextResponse.json({ success: true })
  }

  const orderId = payload?.order_id
  const event = payload?.event
  if (!orderId || !event) return NextResponse.json({ success: true })

  const db = createServerClient()
  const { data: car } = await db
    .from('cars')
    .select(`
      id, location_id, deposit_token, deposit_status, deposit_paid_at,
      deposit_amount, deposit_paid_amount, deposit_receipt_sent_at,
      buyer_phone, buyer_name, make, model, irish_reg,
      locations (
        id, name,
        car_deposit_receipt_sms_enabled,
        twilio_alpha_sender_id
      )
    `)
    .eq('deposit_revolut_order_id', orderId)
    .maybeSingle()
  if (!car) {
    // Webhook for an order we don't know about — could be a different
    // app sharing the same merchant account, or stale. Return 200 so
    // Revolut moves on.
    console.warn(`[revolut-webhook] no car for order ${orderId} (event ${event})`)
    return NextResponse.json({ success: true, skipped: 'unknown_order' })
  }

  // Fetch the live order — gives us authoritative state + actual
  // captured amount, regardless of whether the webhook payload
  // included that detail.
  let order = null
  try {
    order = await getOrder(orderId)
  } catch (e) {
    console.warn(`[revolut-webhook] getOrder failed for ${orderId}: ${e.message}`)
    // Don't 500 — let Revolut retry; the webhook itself was valid.
    return NextResponse.json({ success: true, skipped: 'getorder_failed' })
  }
  if (!order) return NextResponse.json({ success: true, skipped: 'order_missing' })

  // Order states per Revolut Merchant API spec (merchant-2026-03-12.yaml,
  // schema Order-State): pending, processing, authorised, completed,
  // cancelled, failed. We flip our deposit_status only on terminal
  // states. Note: there is NO 'refunded' order state — refunds create
  // a NEW order with type=refund linked via related_order_id; the
  // original order's state stays 'completed'. Refund handling would
  // need a separate flow (not webhook-driven) if we ever build it.
  const updates = {}
  const state = String(order.state || '').toLowerCase()

  switch (state) {
    case 'completed':
      updates.deposit_status = 'paid'
      if (!car.deposit_paid_at) {
        updates.deposit_paid_at = new Date().toISOString()
      }
      // Revolut amounts are minor units. Convert back to majors for
      // display + accounting consistency with the rest of the app.
      if (Number.isFinite(order.amount)) {
        updates.deposit_paid_amount = Number(order.amount) / 100
      }
      break
    case 'cancelled':
      updates.deposit_status = 'cancelled'
      break
    case 'failed':
      updates.deposit_status = 'failed'
      break
    // Transient states (pending / processing / authorised) — no change.
    default:
      return NextResponse.json({ success: true, ignored_state: state })
  }

  if (Object.keys(updates).length > 0) {
    await db.from('cars').update(updates).eq('id', car.id)
  }

  // Project the cars deposit state into the generic orders ledger
  // and emit a contact_events row for the matching transition.
  // Best-effort — orders/events failures must not affect the
  // receipt-SMS step or the webhook 200.
  try {
    const carForOrders = { ...car, ...updates }
    await syncOrderFromCarDeposit({ db, car: carForOrders })
    const evMap = {
      completed: EVENT_TYPES.ORDER_COMPLETED,
      failed: EVENT_TYPES.ORDER_FAILED,
      cancelled: EVENT_TYPES.ORDER_ABANDONED,
    }
    const evType = evMap[state]
    if (evType && car.buyer_email) {
      await emitEvent({
        db,
        eventType: evType,
        contactEmail: car.buyer_email,
        contactId: null, // cars buyers aren't linked to contacts in v1
        locationId: car.location_id,
        sourceType: 'car_deposit',
        sourceId: car.id,
        metadata: {
          amount_cents: Number.isFinite(order.amount) ? order.amount : null,
          car_make: car.make,
          car_model: car.model,
          irish_reg: car.irish_reg,
        },
      })
    }
  } catch (e) {
    console.warn(`[revolut-webhook] orders/events sync failed for car ${car.id}: ${e?.message || e}`)
  }

  // Fire-and-forget receipt SMS to the buyer when the deposit lands.
  // Best-effort — SMS / DB hiccups never affect the webhook response,
  // because the deposit_status update above is the authoritative
  // signal and the receipt is a customer-facing courtesy on top.
  // Three gates inside sendDepositReceiptSms (location toggle,
  // already-sent stamp, no-buyer-phone) skip cheaply; only successful
  // sends stamp deposit_receipt_sent_at, so a Twilio outage during
  // one webhook delivery can be picked up by the next retry.
  let receiptResult = null
  if (state === 'completed') {
    try {
      // Merge the just-applied update into the car snapshot so the
      // body builder sees the actual captured amount even though we
      // haven't refetched.
      const carForReceipt = { ...car, ...updates }
      receiptResult = await sendDepositReceiptSms({
        db,
        car: carForReceipt,
        location: car.locations,
        actorId: null, // webhook — no operator session
      })
    } catch (e) {
      console.warn(`[revolut-webhook] receipt SMS error for car ${car.id}: ${e?.message || e}`)
      receiptResult = { status: 'failed', reason: 'unhandled_exception' }
    }
  }

  return NextResponse.json({ success: true, applied: updates, receipt: receiptResult })
}

// Revolut dashboard hits GET on the URL when configuring the
// webhook — return 200 so it considers the URL valid.
export async function GET() {
  return NextResponse.json({ success: true, ok: 'revolut webhook endpoint' })
}
