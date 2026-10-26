// POST /api/webhooks/revolut/disputes
//
// REVPAY.4 — Revolut Merchant dispute (chargeback) events:
// DISPUTE_ACTION_REQUIRED, DISPUTE_UNDER_REVIEW, DISPUTE_WON, DISPUTE_LOST.
// The payload is just { event, dispute_id }; the dispute itself is read back
// from GET /api/disputes/{id}. Register this URL as its own webhook (its
// signing_secret → REVOLUT_DISPUTE_WEBHOOK_SECRET; falls back to the shared
// REVOLUT_WEBHOOK_SECRET). Shape mirrors /api/webhooks/revolut/donations:
// signature-verify → dedupe → read → record.
//
// Never 500s after the dedupe claim: every failure to read or record RELEASES
// the claim and answers 200 { deferred }, so a resend from the Revolut
// dashboard is processed. A failed staff alert does NOT release it: the dispute
// is already recorded, and re-running would only repeat the write.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getDispute } from '@/lib/revolut'
import {
  resolveDisputeSource,
  upsertDispute,
  noteDisputeOnOrder,
  alertStaffOfDispute,
} from '@/lib/revolut-disputes'
import { recordWebhookEvent, releaseWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'

const ALERT_EVENTS = new Set(['DISPUTE_ACTION_REQUIRED', 'DISPUTE_LOST'])

export async function POST(request) {
  const rawBody = await request.text()
  const sig = request.headers.get('revolut-signature')
  const ts = request.headers.get('revolut-request-timestamp')
  const secrets = [
    process.env.REVOLUT_DISPUTE_WEBHOOK_SECRET,
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

  const disputeId = payload?.dispute_id
  const event = payload?.event
  if (!disputeId || !event) return NextResponse.json({ success: true })

  const db = createServerClient()
  const eventId = `${event}:${disputeId}`

  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.REVOLUT_DISPUTE,
    eventId,
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  const defer = async () => {
    await releaseWebhookEvent({ db, provider: WEBHOOK_PROVIDERS.REVOLUT_DISPUTE, eventId })
    return NextResponse.json({ success: true, deferred: true })
  }

  let row
  let source
  try {
    // Authoritative state from Revolut (the payload carries only ids).
    let dispute
    try {
      dispute = await getDispute(disputeId)
    } catch (e) {
      logWarn('revolut-dispute-webhook', `getDispute failed for ${disputeId}`, { err: e, event })
      return await defer()
    }
    if (!dispute?.id) {
      logWarn('revolut-dispute-webhook', `dispute ${disputeId} not returned`, { event })
      return await defer()
    }

    // A dispute on an order that is not ours is still recorded, with a null source.
    source = await resolveDisputeSource(db, dispute.payment?.order_id)
    row = await upsertDispute(db, dispute, source)
  } catch (e) {
    logError('revolut-dispute-webhook', `handler failed for dispute ${disputeId}`, { err: e, event })
    return await defer()
  }

  if (!source) {
    logWarn('revolut-dispute-webhook', `no sale row for order ${row.order_id}`, { disputeId, event })
  }

  // Ledger note: best-effort, the dispute row above is the record.
  try {
    await noteDisputeOnOrder(db, row.order_id, row)
  } catch (e) {
    logWarn('revolut-dispute-webhook', `orders note failed for dispute ${disputeId}`, { err: e })
  }

  if (ALERT_EVENTS.has(event)) {
    try {
      await alertStaffOfDispute(db, event, row, source)
    } catch (e) {
      logWarn('revolut-dispute-webhook', `alert failed for dispute ${disputeId}`, { err: e })
    }
  }

  return NextResponse.json({ success: true, state: row.state })
}

// Revolut hits GET when configuring the webhook URL — return 200.
export async function GET() {
  return NextResponse.json({ success: true, ok: 'disputes revolut webhook endpoint' })
}
