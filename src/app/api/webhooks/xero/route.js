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
import { withFreshToken } from '@/lib/xero/client'
import { verifyXeroSignature } from '@/lib/xero/webhooks'

export const runtime = 'nodejs'

// The webhook payload carries only IDs — fetch the live invoice so
// Status / AmountPaid / AmountDue / FullyPaidOnDate are authoritative.
// Returns null (not throws) so one bad event can't fail the batch:
// Xero retries on a non-2xx and we don't want a token-refresh blip
// to spam retries across every event in the delivery.
async function fetchXeroInvoice(locationId, invoiceId) {
  try {
    const { xfetch } = await withFreshToken(locationId)
    const json = await xfetch(`/Invoices/${invoiceId}`)
    return json?.Invoices?.[0] || null
  } catch (e) {
    console.warn(`[xero-webhook] failed to fetch invoice ${invoiceId}: ${e?.message || e}`)
    return null
  }
}

// CCF Autos customer invoice (ACCREC) — payment status on the car.
async function applyToCar(db, car, invoice) {
  const updates = { xero_invoice_status: invoice.Status }
  if (invoice.Status === 'PAID' && !car.xero_invoice_paid_at) {
    updates.xero_invoice_paid_at = invoice.FullyPaidOnDate
      ? new Date(invoice.FullyPaidOnDate).toISOString()
      : new Date().toISOString()
    updates.xero_invoice_amount_paid = invoice.AmountPaid != null
      ? Number(invoice.AmountPaid)
      : null
  }
  // Voided in Xero? Clear our cached fields so the UI returns to the
  // 'no invoice issued' state and the operator can re-issue.
  if (invoice.Status === 'VOIDED' && car.xero_invoice_status !== 'VOIDED') {
    updates.xero_invoice_paid_at = null
    updates.xero_invoice_amount_paid = null
  }
  await db.from('cars').update(updates).eq('id', car.id)
}

// XERO-WEBHOOK.1 — supplier bill (ACCPAY) — payment status on the
// invoices_queue row, so the /invoices inbox can show "Paid · date"
// once the bookkeeper reconciles the bill in Xero.
async function applyToBill(db, row, invoice) {
  const paid = invoice.Status === 'PAID'
  await db
    .from('invoices_queue')
    .update({
      xero_bill_status: invoice.Status || null,
      xero_bill_amount_paid: invoice.AmountPaid != null ? Number(invoice.AmountPaid) : null,
      xero_bill_amount_due: invoice.AmountDue != null ? Number(invoice.AmountDue) : null,
      // Keep the first paid date we saw; only (re)set it while paid.
      xero_bill_paid_at: paid
        ? (row.xero_bill_paid_at
            || (invoice.FullyPaidOnDate
              ? new Date(invoice.FullyPaidOnDate).toISOString()
              : new Date().toISOString()))
        : null,
      xero_bill_status_synced_at: new Date().toISOString(),
    })
    .eq('id', row.id)
}

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

  for (const event of payload.events) {
    if (event.eventCategory !== 'INVOICE') { skipped++; continue }
    const invoiceId = event.resourceId
    if (!invoiceId) { skipped++; continue }

    // CCF Autos customer invoice? Invoice IDs are unique per tenant
    // and we only ever store an id we got back from our own POST, so
    // a match-by-id is safe.
    const { data: car } = await db
      .from('cars')
      .select('id, location_id, xero_invoice_id, xero_invoice_status, xero_invoice_paid_at')
      .eq('xero_invoice_id', invoiceId)
      .maybeSingle()
    if (car) {
      const invoice = await fetchXeroInvoice(car.location_id, invoiceId)
      if (!invoice) { skipped++; continue }
      await applyToCar(db, car, invoice)
      processed++
      continue
    }

    // Otherwise — a supplier bill the ingest pushed?
    const { data: bill } = await db
      .from('invoices_queue')
      .select('id, location_id, xero_bill_id, xero_bill_status, xero_bill_paid_at')
      .eq('xero_bill_id', invoiceId)
      .maybeSingle()
    if (bill) {
      const invoice = await fetchXeroInvoice(bill.location_id, invoiceId)
      if (!invoice) { skipped++; continue }
      await applyToBill(db, bill, invoice)
      processed++
      continue
    }

    // Neither — an invoice the CRM didn't create. Ignore.
    skipped++
  }

  return NextResponse.json({ success: true, processed, skipped })
}

// Xero pings GET on the URL when you save the webhook config in the
// developer portal — return 200 so the validation passes.
export async function GET() {
  return NextResponse.json({ success: true, ok: 'xero webhook endpoint' })
}
