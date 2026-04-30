// Car Processing — shared helpers used by the API routes and the
// detail page UI. Single source of truth for "what does this car
// need before it can be marked complete?".

// Required documents for a car to be promoted to 'completed'. All
// of these must have at least one upload before the operator can
// hit Mark Completed (server-side check in completionGaps()). 'other'
// is a free-form bucket for anything not listed and isn't required.
export const REQUIRED_DOCUMENT_TYPES = Object.freeze([
  { key: 'nct_invoice',    label: 'NCT invoice' },
  { key: 'irish_customs',  label: 'Irish customs invoice' },
  { key: 'bca_invoice',    label: 'BCA invoice (incl. VAT)' },
  { key: 'transporter',    label: 'Car transporter invoice' },
  { key: 'ferry_invoice',  label: 'Ferry invoice' },
])

export const ALL_DOCUMENT_TYPES = Object.freeze([
  ...REQUIRED_DOCUMENT_TYPES,
  { key: 'other', label: 'Other' },
])

/**
 * Returns an array of human-readable strings describing what's still
 * outstanding before this car can be moved from 'pending' to
 * 'completed'. Empty array means the car is ready to close.
 *
 * @param {{ buyer_name?: string, xero_invoice_id?: string, uk_vat_refund_received?: boolean, car_documents?: {doc_type: string}[] }} car
 * @returns {string[]}
 */
export function completionGaps(car) {
  if (!car) return ['No car data']
  const gaps = []
  if (!car.buyer_name) gaps.push('Buyer details')
  if (!car.xero_invoice_id) gaps.push('Xero customer invoice issued')
  if (!car.uk_vat_refund_received) gaps.push('UK VAT refund received')

  const presentTypes = new Set((car.car_documents || []).map(d => d.doc_type))
  for (const req of REQUIRED_DOCUMENT_TYPES) {
    if (!presentTypes.has(req.key)) gaps.push(req.label)
  }
  return gaps
}

// Per-car ancillary cost line items captured at registration. Listed
// here as the single source of truth so the form, the inline editor
// on the detail page, and totalAncillaryCosts() all stay in sync.
//
// Add a new cost type by appending one entry — the UI / profit calc
// pick it up automatically.
export const COST_FIELDS = Object.freeze([
  { key: 'uk_transporter_cost', label: 'UK transporter' },
  { key: 'ferry_cost',          label: 'Ferry' },
  { key: 'import_customs_cost', label: 'Import customs' },
  { key: 'nct_cost',            label: 'NCT' },
  { key: 'additional_costs',    label: 'Additional', hasLabelField: true },
])

/**
 * Sum of every per-car ancillary cost. NULLs coerce to 0 so a car
 * created before migration 026 (or one whose operator hasn't filled
 * the costs in yet) just contributes nothing to the total — its
 * profit number reflects pre-cost margin.
 */
export function totalAncillaryCosts(car) {
  if (!car) return 0
  let sum = 0
  for (const c of COST_FIELDS) {
    sum += Number(car[c.key] || 0)
  }
  return Math.round(sum * 100) / 100
}

/**
 * Profit estimate. Uses ex-VAT on both sides so the number reflects
 * the operator's margin rather than gross turnover, and subtracts
 * every per-car cost line item (UK transporter, ferry, customs,
 * NCT, additional). Returns null only when both core prices are
 * unset — partial data with one side filled gives a meaningful
 * (if optimistic) preview.
 */
export function estimatedProfit(car) {
  const sale = Number(car?.irish_sale_price_ex_vat || 0)
  const cost = Number(car?.uk_purchase_price_ex_vat || 0)
  if (!sale && !cost) return null
  const ancillary = totalAncillaryCosts(car)
  return Math.round((sale - cost - ancillary) * 100) / 100
}
