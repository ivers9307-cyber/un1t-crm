// POST /api/webhooks/xero
//
// Xero webhook endpoint — fires on subscribed events. We subscribe
// to INVOICE create+update and route each event to whichever record
// it belongs to:
//   • CCF Autos customer invoices (ACCREC) → the `cars` row
//   • supplier bills (ACCPAY)              → the `invoices_queue` row
// A Xero invoice is only ever one or the other, so we try the car
// match first and fall through to the bill match.
//
// Auth: HMAC-SHA256 of the raw request body using the per-webhook
// signing key from the Xero developer portal. Set XERO_WEBHOOK_KEY
// in Vercel env. The signature arrives in the `x-xero-signature`
// header as base64. (See src/lib/xero/webhooks.js.)
//
// Xero requires a sub-5-second response. We process inline (a SELECT
// + one /Invoices GET + an UPDATE per event — cheap at gym volumes)
// and return 200. On signature mismatch we return 401; Xero
// auto-disables the hook after enough failures.
//
// Payload shape (truncated):
//   { events: [{
//       resourceId,      ← InvoiceID (UUID)
//       eventType,       ← 'CREATE' | 'UPDATE'
//       eventCategory,   ← 'INVOICE'
//       tenantId,
//   }]}
//
// We don't trust the payload — the only reliable bit is resourceId.
// To get the real Status + AmountPaid we fetch /Invoices/{id}
// ourselves through withFreshToken().

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { processXeroInvoiceEvent } from '@/lib/xero/webhook-events'
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'
import { logWarn, logError } from '@/lib/log'
import { verifyXeroSignature } from '@/lib/xero/webhooks'

export const runtime = 'nodejs'

export async function POST(request) {
  // Read the raw body BEFORE parsing — the HMAC is computed over the
  // exact bytes Xero sent.
  const rawBody = await request.text()
  const sig = request.headers.get('x-xero-signature')

  if (!process.env.XERO_WEBHOOK_KEY) {
    console.warn('[xero-webhook] XERO_WEBHOOK_KEY not set — rejecting all hooks')
  }
  if (!verifyXeroSignature(rawBody, sig, process.env.XERO_WEBHOOK_KEY)) {
    return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 })
  }

  let payload = null
  try {
    payload = JSON.parse(rawBody)
  } catch {
    // Xero sends an EMPTY body during the "intent to receive" check —
    // the signature is still valid (HMAC of the empty string), so a
    // 200 completes the handshake.
    return NextResponse.json({ success: true })
  }
  if (!payload?.events?.length) return NextResponse.json({ success: true })

  const db = createServerClient()
  let processed = 0
  let skipped = 0
  let deadLettered = 0

  for (const event of payload.events) {
    let result
    try {
      result = await processXeroInvoiceEvent(db, event)
    } catch (e) {
      result = { status: 'failed', reason: 'threw', error: e }
    }
    if (result.status === 'processed') { processed++; continue }
    if (result.status === 'ignored') { skipped++; continue }
    // XEROHOOK.1 — a failure is kept and replayed (webhook-replay, provider
    // 'xero'), never counted as skipped: answering 200 on it used to lose the
    // paid status for good. 200 still, so Xero keeps the hook enabled.
    logWarn('xero-webhook', 'event not recorded; dead-lettered for replay', { reason: result.reason, invoiceId: event?.resourceId || null, err: result.error })
    const captured = await deadLetterWebhook(db, {
      provider: 'xero',
      eventType: event?.eventType || null,
      payload: event,
      error: `${result.reason}: ${result.error?.message || result.error || ''}`.slice(0, 500),
      locationId: result.locationId || null,
    })
    if (!captured?.id) {
      // Not even kept: let Xero retry the delivery rather than lose it.
      logError('xero-webhook', 'event neither recorded nor dead-lettered; asking Xero to retry', { invoiceId: event?.resourceId || null })
      return NextResponse.json({ success: false, error: 'temporarily unavailable' }, { status: 503 })
    }
    deadLettered++
  }

  return NextResponse.json({ success: true, processed, skipped, dead_lettered: deadLettered })
}

// Xero pings GET on the URL when you save the webhook config in the
// developer portal — return 200 so the validation passes.
export async function GET() {
  return NextResponse.json({ success: true, ok: 'xero webhook endpoint' })
}
