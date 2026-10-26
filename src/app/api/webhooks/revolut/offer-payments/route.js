// POST /api/webhooks/revolut/offer-payments
//
// SEPARATE Revolut webhook receiver for weekend-sale offer purchases
// (OFFERS.5). Register this URL as its own webhook endpoint in Revolut
// (returns its own signing_secret → REVOLUT_OFFER_WEBHOOK_SECRET).
// Mirrors /api/webhooks/revolut/class-bookings — signature-verify →
// dedupe → resolve → getOrder → mark, with sale-offers helpers.
//
// On a paid order: state→'paid', then fire-and-forget contact link/tag +
// staff ops alert (the public status route runs the same pair when its
// rate-capped recheck wins the race; markOfferPurchaseState's
// changed-guard means exactly one path runs them). Idempotent via
// webhook_events (provider REVOLUT_OFFER) + the row's own state guard;
// returns 200 on anything unrecognised so Revolut doesn't auto-disable
// the hook.
//
// REVPAY.1 — resolve FIRST, claim second: every endpoint on the merchant
// account receives every order's events, so another flow's order answers 200
// skipped with no dedupe row and no log line. After the claim, a deferral
// (getOrder throws, the state write throws) releases the claim and answers
// 200 { deferred } (the donations route's pattern). The paid side effects
// after a write that landed never release it: they would re-send the receipt.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import {
  resolveOfferPurchaseByOrderId,
  markOfferPurchaseState,
  linkOrCreateContactForPurchase,
  notifyStaffOfPaidPurchase,
} from '@/lib/sale-offers'
import { sendOfferPurchaseEmail } from '@/lib/offer-purchase-emails'
import { recordWebhookEvent, releaseWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'

export async function POST(request) {
  const rawBody = await request.text()
  const sig = request.headers.get('revolut-signature')
  const ts = request.headers.get('revolut-request-timestamp')
  // Dedicated secret first, shared merchant secret as the fallback so the
  // route verifies before REVOLUT_OFFER_WEBHOOK_SECRET is set in Vercel.
  const secrets = [
    process.env.REVOLUT_OFFER_WEBHOOK_SECRET,
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
  // is claimed yet).
  let purchase
  try {
    purchase = await resolveOfferPurchaseByOrderId(db, orderId, { throwOnError: true })
  } catch (e) {
    logWarn('offer-webhook', 'offer_purchases lookup failed; deferred', { err: e, orderId, event })
    return NextResponse.json({ success: true, deferred: true })
  }
  if (!purchase) {
    // Another flow's order or a stale id. Normal traffic, so no log; 200 so
    // Revolut moves on.
    return NextResponse.json({ success: true, skipped: 'unknown_order' })
  }

  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.REVOLUT_OFFER,
    eventId,
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  // Give the claim back and answer 200.
  const defer = async () => {
    await releaseWebhookEvent({ db, provider: WEBHOOK_PROVIDERS.REVOLUT_OFFER, eventId })
    return NextResponse.json({ success: true, deferred: true })
  }

  // Refresh authoritative state from Revolut (payload state can be stale
  // during retries).
  let order
  try {
    order = await getOrder(orderId)
  } catch (e) {
    logWarn('offer-webhook', `getOrder failed for ${orderId}`, { err: e })
    return await defer()
  }
  if (!order) return NextResponse.json({ success: true, skipped: 'order_missing' })

  const providerState = String(order.state || '').toLowerCase()
  let changed
  let state
  try {
    // Throws on a failed write.
    ({ changed, state } = await markOfferPurchaseState({ db, purchase, providerState }))
  } catch (e) {
    logError('offer-webhook', `offer purchase state write failed for order ${orderId}; deferred`, { err: e, purchaseId: purchase.id })
    return await defer()
  }

  if (changed && state === 'paid') {
    // Fire-and-forget: a contact/notify failure must never 500 the webhook.
    try {
      const { contactId } = await linkOrCreateContactForPurchase(db, purchase)
      await notifyStaffOfPaidPurchase(db, purchase, purchase.offer || {})
      // Buyer receipt. Deliberately says "within 24 hours", NOT "it's ready" —
      // fulfilment is a manual Glofox step that has not happened yet.
      await sendOfferPurchaseEmail(db, {
        purchase: { ...purchase, contact_id: purchase.contact_id || contactId || null },
        offer: purchase.offer || {},
        kind: 'paid',
      })
    } catch (e) {
      logWarn('offer-webhook', `paid side-effects failed for ${purchase.id}`, { err: e })
    }
  }

  return NextResponse.json({ success: true, state })
}

// Revolut hits GET when configuring the webhook URL — return 200 so they
// consider it valid.
export async function GET() {
  return NextResponse.json({ success: true, ok: 'offer-payments revolut webhook endpoint' })
}
