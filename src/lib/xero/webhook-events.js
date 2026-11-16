// XEROHOOK.1 (15 Nov 2026 feature audit, area 21) — one Xero INVOICE webhook
// event, shared by POST /api/webhooks/xero and the dead-letter replayer
// (src/lib/webhook-replay.js, provider 'xero').
//
// The webhook used to count a failed read, a failed Xero fetch or a failed
// write as "skipped" and answer 200, so Xero never retried and a paid status
// was never recorded. processXeroInvoiceEvent now says `failed` for each of
// those; the route dead-letters the event (still answering 200, so Xero keeps
// the hook), and the replayer re-runs this function, which is safe to repeat:
// it re-reads the live invoice and writes its current status.

import { withFreshToken } from '@/lib/xero/client'

// Xero returns dates in several shapes depending on the field/endpoint:
//   • Microsoft JSON   "/Date(1612137600000+0000)/"   (Status/payment dates)
//   • ISO 8601         "2026-05-29T00:00:00"
//   • plain date       "2026-05-29"
// new Date("/Date(...)/") is Invalid Date, and .toISOString() on an
// Invalid Date throws `RangeError: Invalid time value` — which crashed
// this webhook (HTTP 500) the moment a PAID invoice with a
// FullyPaidOnDate arrived, so Xero saw non-2XX and disabled the hook.
// Parse defensively and return null on anything unrecognised; callers
// fall back to now() or null rather than throwing.
export function parseXeroDate(value) {
  if (!value) return null
  if (typeof value === 'string') {
    const ms = value.match(/\/Date\((-?\d+)/)
    if (ms) {
      const d = new Date(Number(ms[1]))
      return Number.isNaN(d.getTime()) ? null : d.toISOString()
    }
  }
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// The webhook payload carries only IDs — fetch the live invoice so
// Status / AmountPaid / AmountDue / FullyPaidOnDate are authoritative.
// Returns null (not throws) so one bad event can't fail the batch:
// Xero retries on a non-2xx and we don't want a token-refresh blip
// to spam retries across every event in the delivery.
async function fetchXeroInvoice(locationId, invoiceId) {
  try {
    const { xfetch } = await withFreshToken(locationId)
    const json = await xfetch(`/Invoices/${invoiceId}`)
    const invoice = json?.Invoices?.[0] || null
    return invoice ? { invoice } : { error: new Error('Xero returned no invoice') }
  } catch (e) {
    return { error: e }
  }
}

// CCF Autos customer invoice (ACCREC) — payment status on the car.
async function applyToCar(db, car, invoice) {
  const updates = { xero_invoice_status: invoice.Status }
  if (invoice.Status === 'PAID' && !car.xero_invoice_paid_at) {
    updates.xero_invoice_paid_at =
      parseXeroDate(invoice.FullyPaidOnDate) || new Date().toISOString()
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
  const { error } = await db.from('cars').update(updates).eq('id', car.id)
  return error || null
}

// XERO-WEBHOOK.1 — supplier bill (ACCPAY) — payment status on the
// invoices_queue row, so the /invoices inbox can show "Paid · date"
// once the bookkeeper reconciles the bill in Xero.
async function applyToBill(db, row, invoice) {
  const paid = invoice.Status === 'PAID'
  const { error } = await db
    .from('invoices_queue')
    .update({
      xero_bill_status: invoice.Status || null,
      xero_bill_amount_paid: invoice.AmountPaid != null ? Number(invoice.AmountPaid) : null,
      xero_bill_amount_due: invoice.AmountDue != null ? Number(invoice.AmountDue) : null,
      // Keep the first paid date we saw; only (re)set it while paid.
      xero_bill_paid_at: paid
        ? (row.xero_bill_paid_at
            || parseXeroDate(invoice.FullyPaidOnDate)
            || new Date().toISOString())
        : null,
      xero_bill_status_synced_at: new Date().toISOString(),
    })
    .eq('id', row.id)
  return error || null
}


/**
 * Handle one webhook event.
 * @param {object} db service-role client
 * @param {{ eventCategory?: string, resourceId?: string, eventType?: string }} event
 * @param {{ fetchInvoice?: Function }} [deps]
 * @returns {Promise<
 *   | { status: 'processed', kind: 'car'|'bill', locationId: string }
 *   | { status: 'ignored', reason: string }
 *   | { status: 'failed', reason: string, error?: any, locationId?: string|null }
 * >}
 */
export async function processXeroInvoiceEvent(db, event, { fetchInvoice = fetchXeroInvoice } = {}) {
  if (event?.eventCategory !== 'INVOICE') return { status: 'ignored', reason: 'not_invoice' }
  const invoiceId = event.resourceId
  if (!invoiceId) return { status: 'ignored', reason: 'no_resource_id' }

  // CCF Autos customer invoice? We only ever store an id we got back from
  // our own POST, so a match-by-id is safe.
  const { data: car, error: carErr } = await db
    .from('cars')
    .select('id, location_id, xero_invoice_id, xero_invoice_status, xero_invoice_paid_at')
    .eq('xero_invoice_id', invoiceId)
    .maybeSingle()
  if (carErr) return { status: 'failed', reason: 'car_read_failed', error: carErr }
  if (car) {
    const { invoice, error } = await fetchInvoice(car.location_id, invoiceId)
    if (!invoice) return { status: 'failed', reason: 'xero_fetch_failed', error, locationId: car.location_id }
    const writeErr = await applyToCar(db, car, invoice)
    if (writeErr) return { status: 'failed', reason: 'car_write_failed', error: writeErr, locationId: car.location_id }
    return { status: 'processed', kind: 'car', locationId: car.location_id }
  }

  // Otherwise — a supplier bill the ingest pushed?
  const { data: bill, error: billErr } = await db
    .from('invoices_queue')
    .select('id, location_id, xero_bill_id, xero_bill_status, xero_bill_paid_at')
    .eq('xero_bill_id', invoiceId)
    .maybeSingle()
  if (billErr) return { status: 'failed', reason: 'bill_read_failed', error: billErr }
  if (bill) {
    const { invoice, error } = await fetchInvoice(bill.location_id, invoiceId)
    if (!invoice) return { status: 'failed', reason: 'xero_fetch_failed', error, locationId: bill.location_id }
    const writeErr = await applyToBill(db, bill, invoice)
    if (writeErr) return { status: 'failed', reason: 'bill_write_failed', error: writeErr, locationId: bill.location_id }
    return { status: 'processed', kind: 'bill', locationId: bill.location_id }
  }

  // Neither — an invoice the CRM didn't create.
  return { status: 'ignored', reason: 'not_ours' }
}
