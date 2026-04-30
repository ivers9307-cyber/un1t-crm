// Car Processing — shared helpers used by the API routes and the
// detail page UI. Single source of truth for "what does this car
// need before it can be marked complete?".

// Required documents for a car to be promoted to 'completed'.
// The buyer is expected to have all four invoices on file. 'other'
// is just a free-form bucket and isn't required.
export const REQUIRED_DOCUMENT_TYPES = Object.freeze([
  { key: 'nct_invoice',    label: 'NCT invoice' },
  { key: 'irish_customs',  label: 'Irish customs invoice' },
  { key: 'bca_invoice',    label: 'BCA invoice (incl. VAT)' },
  { key: 'transporter',    label: 'Car transporter invoice' },
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

/**
 * Profit estimate from the operator-entered prices. We use the
 * ex-VAT figures on both sides so the number reflects the operator's
 * margin rather than gross turnover.
 */
export function estimatedProfit(car) {
  const sale = Number(car?.irish_sale_price_ex_vat || 0)
  const cost = Number(car?.uk_purchase_price_ex_vat || 0)
  if (!sale || !cost) return null
  return Math.round((sale - cost) * 100) / 100
}
