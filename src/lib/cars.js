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
// Each entry carries a `currency` so totalAncillaryCosts() and
// estimatedProfit() can convert GBP costs to EUR using the per-car
// fx_gbp_to_eur rate before they're added to the EUR-denominated
// margin. UK transporter is the only GBP cost today (UK leg of the
// journey) — everything else is paid in Ireland in EUR.
//
// Add a new cost type by appending one entry — the UI / profit calc
// pick it up automatically.
export const COST_FIELDS = Object.freeze([
  { key: 'uk_transporter_cost', label: 'UK transporter', currency: 'GBP' },
  { key: 'ferry_cost',          label: 'Ferry',          currency: 'EUR' },
  { key: 'import_customs_cost', label: 'Import customs', currency: 'EUR' },
  { key: 'nct_cost',            label: 'NCT',            currency: 'EUR' },
  { key: 'additional_costs',    label: 'Commission payout', currency: 'EUR' },
])

// Default GBP→EUR rate used when a car doesn't yet have an explicit
// fx_gbp_to_eur set (operator hasn't entered the rate they got).
// Sensible recent value; UI flags when it's a default vs custom.
// Bump this when the operator's bank changes its quote for new
// purchases — it's a soft default, real cars override.
export const DEFAULT_GBP_TO_EUR = 1.17

// Returns the FX rate to use for a car, falling back to the global
// default when the per-car field is unset.
export function effectiveFxRate(car) {
  const r = Number(car?.fx_gbp_to_eur)
  return Number.isFinite(r) && r > 0 ? r : DEFAULT_GBP_TO_EUR
}

// Whether the car is using the global default (true) vs an
// explicit operator-entered rate (false). Used to decorate the UI.
export function isUsingDefaultFx(car) {
  const r = Number(car?.fx_gbp_to_eur)
  return !(Number.isFinite(r) && r > 0)
}

// Irish VAT rate. The Irish-side display is split into three values
// derived from a single source: IE ex-VAT.
//
//   IE ex-VAT     editable, source of truth
//   IE VAT        ex-VAT × 0.23     (just the VAT amount)
//   Sale price    ex-VAT × 1.23     (also persisted as
//                                    irish_sale_price_inc_vat in the
//                                    DB — that column is the sale
//                                    price total)
//
// Backwards-compat: legacy rows entered only the sale price (in the
// old "IE inc-VAT" field). For those, splitIrishPrice() derives
// ex-VAT from the sale price so all three values still show.
export const IRISH_VAT_RATE = 0.23

// Returns sale price (= ex-VAT × 1.23) given a number/string ex-VAT.
export function applyIrishVat(exVat) {
  if (exVat == null || exVat === '') return null
  const n = Number(exVat)
  if (!Number.isFinite(n)) return null
  return Math.round(n * (1 + IRISH_VAT_RATE) * 100) / 100
}

// Inverse: given a sale price (inc-VAT total), derive the ex-VAT
// figure. Used when the operator edits the Sale price field instead
// of IE ex-VAT — both fields are valid input points and either
// can drive the other.
export function salePriceToExVat(salePrice) {
  if (salePrice == null || salePrice === '') return null
  const n = Number(salePrice)
  if (!Number.isFinite(n)) return null
  return Math.round((n / (1 + IRISH_VAT_RATE)) * 100) / 100
}

// Single resolver used by every Irish-price renderer. Returns
// `{ exVat, vat, salePrice }` populated as fully as the inputs
// allow. ex-VAT wins when both columns hold values; we only fall
// back to deriving from sale price (the legacy path) when ex-VAT is
// null but sale price isn't.
export function splitIrishPrice(car) {
  let exVat = car?.irish_sale_price_ex_vat != null && car.irish_sale_price_ex_vat !== ''
    ? Number(car.irish_sale_price_ex_vat) : null
  let salePrice = car?.irish_sale_price_inc_vat != null && car.irish_sale_price_inc_vat !== ''
    ? Number(car.irish_sale_price_inc_vat) : null

  if (exVat != null && Number.isFinite(exVat)) {
    // ex-VAT wins. Recompute sale price so the two stay consistent
    // even if the stored DB value drifted (legacy hand-edits).
    salePrice = Math.round(exVat * (1 + IRISH_VAT_RATE) * 100) / 100
  } else if (salePrice != null && Number.isFinite(salePrice)) {
    // Legacy row — derive ex-VAT from the entered sale price.
    exVat = Math.round((salePrice / (1 + IRISH_VAT_RATE)) * 100) / 100
  } else {
    return { exVat: null, vat: null, salePrice: null }
  }

  const vat = Math.round((salePrice - exVat) * 100) / 100
  return { exVat, vat, salePrice }
}

/**
 * Sum of every per-car ancillary cost, in EUR. GBP-denominated lines
 * (currently just UK transporter) are converted using the car's
 * effectiveFxRate(). NULLs coerce to 0 so a partial entry doesn't
 * blow up; pre-migration rows simply contribute nothing.
 */
export function totalAncillaryCosts(car) {
  if (!car) return 0
  const fx = effectiveFxRate(car)
  let sumEur = 0
  for (const c of COST_FIELDS) {
    const v = Number(car[c.key] || 0)
    sumEur += c.currency === 'GBP' ? v * fx : v
  }
  return Math.round(sumEur * 100) / 100
}

/**
 * Profit estimate, returned in EUR. UK ex-VAT and any GBP-priced
 * costs are converted to EUR via the car's FX rate (or the global
 * default when the per-car rate is unset). Uses ex-VAT on both
 * sides so the number reflects margin rather than gross turnover.
 *
 * Returns null only when both core prices are unset — partial data
 * with one side filled gives a meaningful (if optimistic) preview.
 *
 * For UI breakdowns prefer profitBreakdown(car) — same numbers but
 * with the intermediate values exposed.
 */
export function estimatedProfit(car) {
  const b = profitBreakdown(car)
  return b ? b.profit : null
}

/**
 * Decomposed view of the profit calc with each leg shown in EUR.
 * Returns null when there's nothing meaningful to render. Used by
 * both the Add Car form's live hint and the detail page's profit
 * breakdown row.
 */
export function profitBreakdown(car) {
  const saleEur = Number(car?.irish_sale_price_ex_vat || 0)
  const ukExVatGbp = Number(car?.uk_purchase_price_ex_vat || 0)
  if (!saleEur && !ukExVatGbp) return null

  const fx = effectiveFxRate(car)
  const ukExVatEur = Math.round(ukExVatGbp * fx * 100) / 100

  // Split ancillaries into the two currencies for the breakdown
  // line, then sum to a single EUR figure for the profit number.
  let ancillaryGbp = 0
  let ancillaryEur = 0
  for (const c of COST_FIELDS) {
    const v = Number(car?.[c.key] || 0)
    if (c.currency === 'GBP') ancillaryGbp += v
    else ancillaryEur += v
  }
  const ancillaryGbpInEur = Math.round(ancillaryGbp * fx * 100) / 100

  const profit = Math.round(
    (saleEur - ukExVatEur - ancillaryGbpInEur - ancillaryEur) * 100
  ) / 100

  return {
    saleEur: Math.round(saleEur * 100) / 100,
    ukExVatGbp: Math.round(ukExVatGbp * 100) / 100,
    ukExVatEur,
    ancillaryGbp: Math.round(ancillaryGbp * 100) / 100,
    ancillaryGbpInEur,
    ancillaryEur: Math.round(ancillaryEur * 100) / 100,
    fx,
    isUsingDefaultFx: isUsingDefaultFx(car),
    profit,
  }
}
