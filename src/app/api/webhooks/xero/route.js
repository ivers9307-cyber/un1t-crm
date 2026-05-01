// POST /api/webhooks/xero
//
// Xero webhook endpoint — fires on subscribed events (we currently
// subscribe to INVOICE creation+update so we can detect when a
// customer invoice has been paid).
//
// Auth: HMAC-SHA256 of the raw request body using the per-webhook
// signing key from the Xero developer portal. Set
// XERO_WEBHOOK_KEY in Vercel env. The signature comes in the
// `x-xero-signature` header as base64.
//
// Xero requires a sub-5-second response. We process the payload
// inline (cheap — single SELECT + UPDATE per event) and return 200.
// On signature mismatch return 401 and Xero auto-disables the
// hook after enough failures.
//
// Payload shape (truncated):
//   { events: [{
//       resourceUrl,
//       resourceId,        ← InvoiceID (UUID)
//       eventDateUtc,
//       eventType,         ← 'CREATE' | 'UPDATE'
//       eventCategory,     ← 'INVOICE'
//       tenantId,
//       tenantType,
//   }]}
//
// We don't trust the payload — the only reliable bits are the
// resourceId + tenantId. To get the actual Status + AmountPaid we
// fetch /Invoices/{id} ourselves through withFreshToken().

import { NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { withFreshToken } from '@/lib/xero/client'

export const runtime = 'nodejs'

function verifyXeroSignature(rawBody, headerSig) {
  const key = process.env.XERO_WEBHOOK_KEY
  if (!key) {
    console.warn('[xero-webhook] XERO_WEBHOOK_KEY not set — rejecting all hooks')
    return false
  }
  if (!headerSig) return false
  const computed = createHmac('sha256', key).update(rawBody).digest('base64')
  // timingSafeEqual requires equal-length buffers.
  const a = Buffer.from(computed)
  const b = Buffer.from(headerSig)
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(request) {
  // Read raw body BEFORE parsing — HMAC computed over the exact bytes Xero sent.
  const rawBody = await request.text()
  const sig = request.headers.get('x-xero-signature')

  if (!verifyXeroSignature(rawBody, sig)) {
    return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 })
  }

  let payload = null
  try { payload = JSON.parse(rawBody) } catch {
    // Xero sends an EMPTY body during the IntelliTrust check —
    // signature is still valid (HMAC of empty string). Respond 200.
    return NextResponse.json({ success: true })
  }
  if (!payload?.events?.length) return NextResponse.json({ success: true })

  const db = createServerClient()
  let processed = 0
  let skipped = 0

  for (const event of payload.events) {
    if (event.eventCategory !== 'INVOICE') { skipped++; continue }
    const invoiceId = event.resourceId
    if (!invoiceId) { skipped++; continue }

    // Find the car this invoice belongs to. Strict match — invoice
    // ids in Xero are unique per tenant, but our cars table only
    // stores xero_invoice_id without tenant scoping. Match-by-id
    // is sufficient because we only ever write the id from our own
    // POST /Invoices flow which round-trips the Xero response.
    const { data: car } = await db
      .from('cars')
      .select('id, location_id, xero_invoice_id, xero_invoice_status, xero_invoice_paid_at')
      .eq('xero_invoice_id', invoiceId)
      .maybeSingle()
    if (!car) { skipped++; continue }

    // Fetch the actual invoice from Xero to get Status + AmountPaid.
    let invoice = null
    try {
      const { xfetch } = await withFreshToken(car.location_id)
      const json = await xfetch(`/Invoices/${invoiceId}`)
      invoice = json?.Invoices?.[0]
    } catch (e) {
      console.warn(`[xero-webhook] Failed to fetch invoice ${invoiceId}: ${e.message}`)
      // Don't fail the whole batch — Xero retries on non-2xx and
      // we don't want a token-refresh blip to spam retries.
      skipped++
      continue
    }
    if (!invoice) { skipped++; continue }

    const updates = { xero_invoice_status: invoice.Status }
    if (invoice.Status === 'PAID' && !car.xero_invoice_paid_at) {
      updates.xero_invoice_paid_at = invoice.FullyPaidOnDate
        ? new Date(invoice.FullyPaidOnDate).toISOString()
        : new Date().toISOString()
      updates.xero_invoice_amount_paid = invoice.AmountPaid != null
        ? Number(invoice.AmountPaid)
        : null
    }
    // Voided in Xero? Clear our cached fields so the UI returns to
    // the 'no invoice issued' state and the operator can re-issue.
    if (invoice.Status === 'VOIDED' && car.xero_invoice_status !== 'VOIDED') {
      updates.xero_invoice_paid_at = null
      updates.xero_invoice_amount_paid = null
    }

    await db.from('cars').update(updates).eq('id', car.id)
    processed++
  }

  return NextResponse.json({ success: true, processed, skipped })
}

// Xero pings GET on the URL when you save the webhook config in
// the developer portal — return 200 so the validation passes.
export async function GET() {
  return NextResponse.json({ success: true, ok: 'xero webhook endpoint' })
}