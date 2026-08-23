// Glofox INVOICE_UPDATED webhook → CRM LTV (GLOFOX2.1.20).
//
// The Glofox /Analytics/report API returns 0 transactions for our
// API key — likely a permission scope at Glofox's end. Until they
// unlock it (or until we get historical via CSV), we accumulate
// per-member Lifetime Value from the INVOICE_UPDATED webhook.
//
// Three-step pipeline per event:
//   1. parseInvoicePayload(payload)         — extract canonical shape
//   2. upsertGlofoxInvoice(...)             — write to source-of-truth
//   3. recomputeContactLifetimeValue(...)   — sum, write aggregates
//
// Idempotency: invoices.id is the PK. Glofox sends INVOICE_UPDATED
// for status transitions (PENDING → PAID → maybe FORGIVEN); we
// upsert the same row, then re-aggregate from scratch. Out-of-
// order delivery converges.

import { selectAll } from '@/lib/select-all'
import { isMembershipInvoice } from '@/lib/glofox-arrears'

/**
 * Parse a Glofox InvoiceEvent.Payload into the row shape we want
 * to write to glofox_invoices.
 *
 * Returns null when required fields are missing — the caller logs
 * + skips rather than throwing.
 *
 * @param {object} payload  the InvoiceEvent.Payload object (per spec)
 *                          OR the wrapping event object (we'll
 *                          unwrap from .Payload if present).
 */
export function parseInvoicePayload(rawEventOrPayload) {
  if (!rawEventOrPayload || typeof rawEventOrPayload !== 'object') return null
  // Glofox wraps invoice data under Payload — unwrap if we got the
  // full event. Caller can also pass the inner Payload directly.
  const p = rawEventOrPayload.Payload && typeof rawEventOrPayload.Payload === 'object'
    ? rawEventOrPayload.Payload
    : rawEventOrPayload
  if (!p.id) return null

  // user.id is the canonical Glofox member id link.
  const glofoxUserId = p.user?.id ? String(p.user.id) : null
  const userEmail = typeof p.user?.email === 'string' ? p.user.email.trim().toLowerCase() : null

  // Status: PAID / PAST_DUE / PENDING / FORGIVEN per spec. Default
  // to UNKNOWN so the row still lands and we can debug from raw.
  const status = typeof p.status === 'string' ? p.status.trim().toUpperCase() : 'UNKNOWN'

  // Amount: total is "the total amount of the invoice" per spec.
  // Glofox sends invoice.line_items[].unit_price as integer cents,
  // and the spec describes total as integer too — we trust it as
  // cents (treating it as floats would risk currency rounding bugs).
  const amountCents = Number.isFinite(p.total) ? Math.round(p.total) : 0

  // Roll up the line item sub_types into a comma-separated string —
  // useful for the AudienceBuilder "members who paid for
  // SUBSCRIPTION_PAYMENT" filter without needing JSONB indexing.
  let subtypes = null
  if (Array.isArray(p.line_items) && p.line_items.length > 0) {
    const set = new Set()
    for (const li of p.line_items) {
      if (li?.sub_type) set.add(String(li.sub_type).toUpperCase())
    }
    if (set.size > 0) subtypes = Array.from(set).sort().join(',')
  }

  // Date: per spec the Payload.date is ISO date-time. created and
  // modified are also ISO. Prefer date (the invoice's own date),
  // fallback to created.
  const invoiceDateRaw = p.date || p.created || p.modified
  let invoiceDate = null
  if (typeof invoiceDateRaw === 'string' && invoiceDateRaw) {
    const d = new Date(invoiceDateRaw)
    if (!Number.isNaN(d.getTime())) invoiceDate = d.toISOString()
  }

  return {
    id: String(p.id),
    glofox_user_id: glofoxUserId,
    user_email: userEmail,
    amount_cents: amountCents,
    currency: p.currency || null,
    status,
    payment_method: p.payment_method || null,
    document_type: p.document_type || null,
    line_item_subtypes: subtypes,
    invoice_date: invoiceDate,
  }
}

/**
 * Upsert a parsed invoice into glofox_invoices, writing the raw
 * event payload too (forensic snapshot — invaluable for debugging
 * any aggregate mismatches later).
 *
 * Returns { ok, row, error }. Caller checks ok before recomputing.
 */
export async function upsertGlofoxInvoice(db, locationId, contactId, parsed, rawEvent) {
  if (!db || !parsed?.id) return { ok: false, error: 'missing args' }
  const row = {
    id: parsed.id,
    contact_id: contactId,
    location_id: locationId,
    glofox_user_id: parsed.glofox_user_id,
    amount_cents: parsed.amount_cents,
    currency: parsed.currency,
    status: parsed.status,
    payment_method: parsed.payment_method,
    document_type: parsed.document_type,
    line_item_subtypes: parsed.line_item_subtypes,
    invoice_date: parsed.invoice_date,
    raw_payload: rawEvent,
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await db
    .from('glofox_invoices')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, row: data }
}

/**
 * Recompute a contact's denormalised LTV aggregates from the
 * source-of-truth glofox_invoices rows. SUMs/COUNTs/MAXes only
 * over PAID invoices for the value; last_invoice_at picks up any
 * status (PAST_DUE, PENDING, FORGIVEN included) so the operator
 * sees Glofox-side activity even when payment hasn't completed.
 *
 * Returns the aggregate values written. Best-effort: failures
 * don't bubble (the invoice is already persisted; the aggregate
 * can be rebuilt later).
 */
export async function recomputeContactLifetimeValue(db, contactId) {
  if (!db || !contactId) return null
  // Page every invoice for the contact — an un-paginated select caps at 1000
  // rows, which silently UNDERCOUNTS lifetime value for any long-tenure member
  // past that many invoices. Order by id so paging is stable; mirrors
  // churn-radar-data.js#fetchInvoicesByStatus. Best-effort: swallow + bail.
  let invoices
  try {
    invoices = await selectAll((from, to) => db
      .from('glofox_invoices')
      .select('amount_cents, currency, status, invoice_date')
      .eq('contact_id', contactId)
      .order('id', { ascending: true })
      .range(from, to))
  } catch {
    return null
  }

  let lifetimeCents = 0
  let paidCount = 0
  let lifetimeCurrency = null
  let lastPaymentMs = 0
  let lastInvoiceMs = 0
  for (const inv of invoices) {
    const ms = inv.invoice_date ? new Date(inv.invoice_date).getTime() : 0
    if (ms > lastInvoiceMs) lastInvoiceMs = ms
    if (inv.status === 'PAID') {
      lifetimeCents += Number(inv.amount_cents) || 0
      paidCount++
      if (ms > lastPaymentMs) lastPaymentMs = ms
      // First-write-wins for currency — UN1T is single-currency in
      // practice (EUR), but defending against a mid-stream change
      // would require a per-currency split which isn't worth the
      // complexity yet.
      if (!lifetimeCurrency && inv.currency) lifetimeCurrency = inv.currency
    }
  }

  const updates = {
    lifetime_value_cents: lifetimeCents,
    lifetime_transaction_count: paidCount,
    lifetime_currency: lifetimeCurrency,
    last_payment_at: lastPaymentMs ? new Date(lastPaymentMs).toISOString() : null,
    last_invoice_at: lastInvoiceMs ? new Date(lastInvoiceMs).toISOString() : null,
  }
  const { error: updErr } = await db
    .from('contacts')
    .update(updates)
    .eq('id', contactId)
  if (updErr) return null
  return updates
}

/**
 * One-shot orchestration for the webhook receiver — parse the
 * invoice payload, upsert the row, recompute the contact's LTV.
 * Returns a structured result the receiver can include in its
 * response/audit log.
 */
export async function applyInvoiceWebhook(db, locationId, contactId, rawEvent) {
  const parsed = parseInvoicePayload(rawEvent)
  if (!parsed) return { ok: false, reason: 'unparseable_invoice' }
  if (!contactId) return { ok: false, reason: 'no_contact', parsed }
  const upsert = await upsertGlofoxInvoice(db, locationId, contactId, parsed, rawEvent)
  if (!upsert.ok) return { ok: false, reason: 'invoice_write_failed', error: upsert.error, parsed }
  const aggs = await recomputeContactLifetimeValue(db, contactId)
  return {
    ok: true,
    invoice_id: parsed.id,
    invoice_status: parsed.status,
    amount_cents: parsed.amount_cents,
    // DUNNING.1 — is this a membership payment (renewal / first payment), i.e.
    // the churn radar's Overdue category? Drives reactive dunning: only a
    // failed MEMBERSHIP invoice starts card-update reminders, and only a
    // settled one stops them.
    is_membership: isMembershipInvoice(parsed),
    aggregates: aggs,
  }
}
