// SALEALERT.1 — a new Glofox purchase (Stillorgan) rings the "sale" push.
//
// Called from the Glofox webhook for INVOICE_UPDATED, through
// ringSaleAfterResponse, so it can never change the webhook's answer. The
// webhook is not a dedup boundary (Glofox redelivers), so the key
// `sale:glofox:<invoice id>` absorbs repeats; no previous status is read.
//
// Allow-list, from the production data read on 23 Nov 2026: a PAID invoice
// above €0, not complimentary, whose every line item is a sale-shaped
// sub-type. Renewals (SUBSCRIPTION_RENEWAL), fees (CUSTOM_CHARGE), prorates and
// NSF recoveries are none of those, so they never ring. A CRM trial or promo
// grant is bought as complimentary at €0, which both checks reject. The grant
// stores its Glofox invoice id only inside a jsonb column with no index, so no
// extra lookup is made (see the report).

import { notifyNewSale } from './sale-alert'
import { parseInvoicePayload } from './glofox-invoices'
import { logError } from './log'

// UPFRONT_PAYMENT: packs and upfront plans; SUBSCRIPTION_PAYMENT: a new
// membership's first payment; BOOK_CLASS: a paid drop-in class.
const SALE_SUBTYPES = Object.freeze(['UPFRONT_PAYMENT', 'SUBSCRIPTION_PAYMENT', 'BOOK_CLASS'])
const FALLBACK_ITEM_NAME = 'Glofox purchase'

/** @param {{status?:string, amount_cents?:number, payment_method?:string|null, line_item_subtypes?:string|null}} invoice a parseInvoicePayload() result */
export function glofoxInvoiceIsNewSale(invoice) {
  if (String(invoice?.status || '').toUpperCase() !== 'PAID') return { ring: false, reason: 'not_paid' }
  if (!(Number(invoice?.amount_cents) > 0)) return { ring: false, reason: 'zero_amount' }
  if (String(invoice?.payment_method || '').toLowerCase() === 'complimentary') return { ring: false, reason: 'complimentary' }
  const subtypes = String(invoice?.line_item_subtypes || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  if (subtypes.length === 0) return { ring: false, reason: 'no_subtypes' }
  if (!subtypes.every((s) => SALE_SUBTYPES.includes(s))) return { ring: false, reason: 'not_a_sale_subtype' }
  return { ring: true, reason: 'new_sale' }
}

function innerPayload(payload) {
  if (!payload || typeof payload !== 'object') return {}
  return payload.Payload && typeof payload.Payload === 'object' ? payload.Payload : payload
}

/** The first named line item, preferring one with a price above zero. */
export function glofoxInvoiceItemName(payload) {
  const items = Array.isArray(innerPayload(payload).line_items) ? innerPayload(payload).line_items : []
  const named = items.filter((li) => typeof li?.name === 'string' && li.name.trim())
  const chosen = named.find((li) => Number(li.unit_price) > 0) || named[0]
  return chosen ? chosen.name.trim() : FALLBACK_ITEM_NAME
}

function buyerFirstName(payload) {
  const user = innerPayload(payload).user
  const first = typeof user?.first_name === 'string' ? user.first_name.trim() : ''
  if (first) return first
  const full = typeof user?.name === 'string' ? user.name.trim() : ''
  return full.split(/\s+/)[0] || undefined
}

/**
 * Ring for one INVOICE_UPDATED delivery. `locationId` is the location the
 * webhook resolved; `contact` is the matched contact or null (an unmatched
 * member still rings). Never throws.
 */
export async function alertGlofoxInvoiceSale(db, { locationId, payload, contact }) {
  try {
    const invoice = parseInvoicePayload(payload)
    if (!invoice?.id || !locationId) return { sent: false, reason: 'missing_key' }
    const verdict = glofoxInvoiceIsNewSale(invoice)
    if (!verdict.ring) return { sent: false, reason: verdict.reason }
    return await notifyNewSale(db, {
      source: 'glofox',
      saleId: invoice.id,
      locationId,
      itemName: glofoxInvoiceItemName(payload),
      amountCents: invoice.amount_cents,
      buyerFirstName: buyerFirstName(payload),
      contactId: contact?.id || undefined,
    })
  } catch (err) {
    logError('glofox-sale-alert', 'glofox sale alert failed', { location_id: locationId, error: err?.message })
    return { sent: false, reason: 'error' }
  }
}
