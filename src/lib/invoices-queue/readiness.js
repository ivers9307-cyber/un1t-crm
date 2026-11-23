// src/lib/invoices-queue/readiness.js
// INVOICEPREP.3 — why an invoice row "Needs a look".
//
// Pure, and safe to import from a client component: no imports, no
// database, no environment. The caller resolves the VAT (vat.js) and
// passes it in. fieldReasons covers only what the fields themselves say;
// the caller adds unreadable, duplicate_file, duplicate_number and
// already_in_xero.

/** In display order. */
export const REVIEW_REASONS = Object.freeze([
  'unreadable',
  'duplicate_file',
  'duplicate_number',
  'already_in_xero',
  'credit_note',
  'not_an_invoice',
  'new_supplier',
  'no_account',
  'no_vat_rate',
  'vat_differs',
  'totals_mismatch',
  'missing_date',
  'zero_total',
])

export const REVIEW_REASON_LABELS = Object.freeze({
  unreadable: 'Could not be read',
  duplicate_file: 'Possible duplicate',
  duplicate_number: 'Possible duplicate',
  already_in_xero: 'Already in Xero',
  credit_note: 'Credit note',
  not_an_invoice: 'May not be an invoice',
  new_supplier: 'New supplier',
  no_account: 'No account yet',
  no_vat_rate: 'No VAT rate',
  vat_differs: 'VAT differs from last time',
  totals_mismatch: "Totals don't add up",
  missing_date: 'No invoice date',
  zero_total: 'Total is zero',
})

const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '')
// Number(null) is 0, so null/blank must map to NaN explicitly.
const num = (v) => (blank(v) ? NaN : Number(v))

/**
 * @param {object|null|undefined} fields  extracted_fields
 * @param {{ vat?: {status?: string}|null, rememberedTaxType?: string|null, taxRates?: Array }} [ctx]
 * @returns {string[]} reasons in REVIEW_REASONS order
 */
export function fieldReasons(fields, ctx = {}) {
  if (!fields || typeof fields !== 'object') return []
  const { vat, rememberedTaxType, taxRates } = ctx || {}
  const out = []

  // A credit note sent as a bill would be booked the wrong way round.
  if (fields.document_type === 'credit_note') out.push('credit_note')
  // A statement or other document a person vouched for is read through, but
  // must never come out Ready and be sent as a bill.
  if (fields.document_type === 'statement' || fields.document_type === 'other') out.push('not_an_invoice')

  const hasContact = !!fields.xero_contact_ref
  if (!hasContact) out.push('new_supplier')
  else if (blank(fields.xero_account_id)) out.push('no_account')

  const subtotal = num(fields.subtotal)
  const tax = num(fields.tax_amount)
  const total = num(fields.total)
  const status = vat?.status ?? (tax === 0 ? 'zero' : 'unmatched')
  const hasType = !blank(fields.tax_type)
  // A person's choice (or a legacy row with a type and no source) always stands.
  const manual = fields.tax_type_source === 'manual' || (hasType && !fields.tax_type_source)
  const breakdown = Number.isFinite(subtotal) && subtotal > 0 && Number.isFinite(tax)
  const receiptNoVat =
    Number.isFinite(total) && total > 0 && !(subtotal > 0) && (tax === 0 || !Number.isFinite(tax))
  if (
    (!hasType && (status === 'unmatched' || status === 'ambiguous')) ||
    (!manual && (!Number.isFinite(tax) || receiptNoVat || (hasType && !breakdown)))
  ) {
    out.push('no_vat_rate')
  }

  if (
    status === 'zero' &&
    fields.tax_type_source !== 'manual' &&
    typeof rememberedTaxType === 'string' && rememberedTaxType !== ''
  ) {
    const row = (Array.isArray(taxRates) ? taxRates : []).find((r) => r?.tax_type === rememberedTaxType)
    const rate = num(row?.effective_rate)
    if (Number.isFinite(rate) && rate > 0) out.push('vat_differs')
  }

  if (
    Number.isFinite(subtotal) && Number.isFinite(tax) && Number.isFinite(total) &&
    subtotal > 0 &&
    Math.abs(Number((subtotal + tax - total).toFixed(4))) > 0.01
  ) {
    out.push('totals_mismatch')
  }

  if (blank(fields.invoice_date)) out.push('missing_date')
  // An unread total must never come out Ready.
  if (!Number.isFinite(total) || total === 0) out.push('zero_total')

  return out
}

/**
 * Union of reason lists: de-duplicated, known reasons only, in REVIEW_REASONS order.
 * @param {...(string[]|null|undefined)} lists
 * @returns {string[]}
 */
export function mergeReasons(...lists) {
  const seen = new Set()
  for (const list of lists) {
    if (Array.isArray(list)) for (const r of list) seen.add(r)
  }
  return REVIEW_REASONS.filter((r) => seen.has(r))
}

/** @param {string[]|null|undefined} reasons */
export function isReady(reasons) {
  return !Array.isArray(reasons) || reasons.length === 0
}
