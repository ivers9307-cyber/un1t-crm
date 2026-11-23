// src/lib/invoices-queue/vat.js
// XERO-BILL-VAT.2 — derive a bill's VAT rate and map it to one of the
// location's real Xero tax types (from the xero_tax_rates cache).
//
// Pure. The push and the review UI both call this. Only three things
// are policy: the match tolerance, the zero default (NONE — Richard's
// call), and the expense-applicability filter. Everything else is
// arithmetic.

const TOLERANCE_PP = 0.5 // percentage points
const ZERO_EPS = 0.001

// Net (ex-VAT) basis for the rate: prefer subtotal, else the line-item
// sum, else total − tax.
function billNet(fields) {
  const subtotal = Number(fields?.subtotal)
  if (Number.isFinite(subtotal) && subtotal > 0) return subtotal
  if (Array.isArray(fields?.line_items) && fields.line_items.length) {
    const sum = fields.line_items.reduce(
      (s, li) => s + (Number(li?.unit_amount) || 0) * Number(li?.quantity ?? 1), 0)
    if (sum > 0) return sum
  }
  const total = Number(fields?.total)
  const tax = Number(fields?.tax_amount)
  if (Number.isFinite(total) && Number.isFinite(tax) && total - tax > 0) return total - tax
  return null
}

const activeExpense = (r) => r?.status === 'ACTIVE' && r?.can_apply_to_expenses === true
// Xero's effective rate for a cached row, as a number (NaN if absent) — a
// rate with no numeric effective_rate can't be matched or treated as 0%.
// NB: Number(null) is 0, so null/undefined must map to NaN explicitly, or a
// rate Xero never gave a value would be wrongly treated as a 0% rate.
const rateOf = (r) => (r?.effective_rate == null ? NaN : Number(r.effective_rate))

// A rate Xero names as a purchases rate ("Purchases Standard 23%", "Purchases
// tax - reduced rate"), and not also as a sales one.
const isPurchasesRate = (r) => /\bpurchases?\b/i.test(String(r?.name ?? '')) && !/\bsales?\b/i.test(String(r?.name ?? ''))
// A sales rate: named as one, or Xero's own system sales type (OUTPUT, OUTPUT2…).
const isSalesRate = (r) => !isPurchasesRate(r) && (/\bsales?\b/i.test(String(r?.name ?? '')) || /^OUTPUT/i.test(String(r?.tax_type ?? '')))

/**
 * @param {object} fields  extracted_fields (subtotal, tax_amount, total, line_items)
 * @param {Array}  taxRates  the location's xero_tax_rates rows
 * @returns {{ taxType: string|null, derivedRate: number|null, status: 'zero'|'matched'|'ambiguous'|'unmatched', candidates: Array }}
 */
export function resolveBillTaxType(fields, taxRates) {
  const rates = Array.isArray(taxRates) ? taxRates : []
  const taxAmount = Number(fields?.tax_amount)

  // Zero VAT → NONE default; offer the location's 0%-effective expense
  // rates (No VAT / Zero Rated / Exempt) as override candidates.
  if (Number.isFinite(taxAmount) && Math.abs(taxAmount) < ZERO_EPS) {
    const zeroCandidates = rates.filter((r) => activeExpense(r) && Number.isFinite(rateOf(r)) && Math.abs(rateOf(r)) < ZERO_EPS)
    return { taxType: 'NONE', derivedRate: 0, status: 'zero', candidates: zeroCandidates }
  }

  const net = billNet(fields)
  if (net == null || !Number.isFinite(taxAmount)) {
    return { taxType: null, derivedRate: null, status: 'unmatched', candidates: rates.filter(activeExpense) }
  }
  const derivedRate = (taxAmount / net) * 100

  const matches = rates
    .filter(activeExpense)
    .filter((r) => Number.isFinite(rateOf(r)) && Math.abs(rateOf(r) - derivedRate) <= TOLERANCE_PP)

  if (matches.length === 1) return { taxType: matches[0].tax_type, derivedRate, status: 'matched', candidates: matches }
  // VATRATE.1 — Xero keeps a sales rate and a purchases rate at the same
  // percentage, and marks both as usable on expenses. A supplier bill takes the
  // purchases one: when exactly one match is a purchases rate and every other
  // match is a sales rate, it wins. Two purchases rates, none, or any other
  // kind of rate beside it (imports, reverse charge) stay ambiguous for a person.
  if (matches.length > 1) {
    const purchases = matches.filter(isPurchasesRate)
    const others = matches.filter((r) => !isPurchasesRate(r))
    if (purchases.length === 1 && others.every(isSalesRate)) {
      return { taxType: purchases[0].tax_type, derivedRate, status: 'matched', candidates: matches }
    }
  }
  if (matches.length > 1) return { taxType: null, derivedRate, status: 'ambiguous', candidates: matches }
  return { taxType: null, derivedRate, status: 'unmatched', candidates: rates.filter(activeExpense) }
}

/**
 * A bill is safe to send only when its VAT rate is resolved: a confirmed
 * `tax_type` is set, OR it's a genuine 0%-VAT bill (tax_amount === 0),
 * which the push resolves to 'NONE' deterministically. Shared by the
 * approval gate (data-approve + bulk-send) and the inbox's sendable count
 * so all three surfaces agree on what "sendable" means.
 */
export function hasResolvedVatRate(fields) {
  const ef = fields || {}
  if (typeof ef.tax_type === 'string' && ef.tax_type.length > 0) return true
  return Number(ef.tax_amount) === 0
}
