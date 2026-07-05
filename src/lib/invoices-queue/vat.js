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
      (s, li) => s + (Number(li?.unit_amount) || 0) * (Number(li?.quantity) ?? 1), 0)
    if (sum > 0) return sum
  }
  const total = Number(fields?.total)
  const tax = Number(fields?.tax_amount)
  if (Number.isFinite(total) && Number.isFinite(tax) && total - tax > 0) return total - tax
  return null
}

const activeExpense = (r) => r?.status === 'ACTIVE' && r?.can_apply_to_expenses === true

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
    const zeroCandidates = rates.filter((r) => activeExpense(r) && Math.abs(Number(r.effective_rate) || 0) < ZERO_EPS)
    return { taxType: 'NONE', derivedRate: 0, status: 'zero', candidates: zeroCandidates }
  }

  const net = billNet(fields)
  if (net == null || !Number.isFinite(taxAmount)) {
    return { taxType: null, derivedRate: null, status: 'unmatched', candidates: rates.filter(activeExpense) }
  }
  const derivedRate = (taxAmount / net) * 100

  const matches = rates
    .filter(activeExpense)
    .filter((r) => Math.abs((Number(r.effective_rate) || 0) - derivedRate) <= TOLERANCE_PP)

  if (matches.length === 1) return { taxType: matches[0].tax_type, derivedRate, status: 'matched', candidates: matches }
  if (matches.length > 1) return { taxType: null, derivedRate, status: 'ambiguous', candidates: matches }
  return { taxType: null, derivedRate, status: 'unmatched', candidates: rates.filter(activeExpense) }
}
