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
 * Required document types must both EXIST and have been forwarded
 * to Xero (xero_file_id populated) — Xero auto-bill OCR turns each
 * forwarded file into a draft Bill, so requiring the forward
 * guarantees the AP side of every car is captured before close.
 *
 * @param {{ buyer_name?: string, xero_invoice_id?: string, uk_vat_refund_received?: boolean, car_documents?: {doc_type: string, xero_file_id?: string}[] }} car
 * @returns {string[]}
 */
export function completionGaps(car) {
  if (!car) return ['No car data']
  const gaps = []
  if (!car.buyer_name) gaps.push('Buyer details')
  if (!car.xero_invoice_id) gaps.push('Xero customer invoice issued')
  if (!car.uk_vat_refund_received) gaps.push('UK VAT refund received')

  const docsByType = new Map()
  for (const d of car.car_documents || []) {
    if (!docsByType.has(d.doc_type)) docsByType.set(d.doc_type, [])
    docsByType.get(d.doc_type).push(d)
  }
  for (const req of REQUIRED_DOCUMENT_TYPES) {
    const docs = docsByType.get(req.key) || []
    if (docs.length === 0) {
      gaps.push(req.label)
      continue
    }
    // At least one of the uploaded docs of this type must have
    // been forwarded to Xero.
    const anySent = docs.some(d => d.xero_file_id)
    if (!anySent) gaps.push(`${req.label} — send to Xero`)
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

// Last-resort GBP→EUR rate when neither the car nor the live cache
// has a value. The auto-fetched rate from src/lib/fx.js
// (api.frankfurter.app, ECB-backed, refreshed every 24h) is the
// normal source — this constant only kicks in when the upstream is
// unreachable AND the per-car snapshot is null.
export const DEFAULT_GBP_TO_EUR = 1.17

// Returns the FX rate to use for a car. Resolution order:
//   1. car.fx_gbp_to_eur            — per-car snapshot (set on creation
//                                      from the live rate, kept stable
//                                      for the life of the deal)
//   2. liveRate                     — today's live rate, passed in by
//                                      the caller (server fetched via
//                                      src/lib/fx.js)
//   3. DEFAULT_GBP_TO_EUR           — hard fallback
export function effectiveFxRate(car, liveRate = null) {
  const carRate = Number(car?.fx_gbp_to_eur)
  if (Number.isFinite(carRate) && carRate > 0) return carRate
  if (Number.isFinite(liveRate) && liveRate > 0) return liveRate
  return DEFAULT_GBP_TO_EUR
}

// Whether the car is using the hardcoded fallback. Returns true only
// when both the snapshot and the live rate are missing — used to
// decorate the UI with a "rate unavailable" caveat.
export function isUsingDefaultFx(car, liveRate = null) {
  const carRate = Number(car?.fx_gbp_to_eur)
  if (Number.isFinite(carRate) && carRate > 0) return false
  if (Number.isFinite(liveRate) && liveRate > 0) return false
  return true
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
 *
 * `liveRate` is optional — if the caller has fetched today's rate
 * from src/lib/fx.js it's passed through; otherwise we fall through
 * to DEFAULT_GBP_TO_EUR.
 */
export function totalAncillaryCosts(car, liveRate = null) {
  if (!car) return 0
  const fx = effectiveFxRate(car, liveRate)
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
export function estimatedProfit(car, liveRate = null) {
  const b = profitBreakdown(car, liveRate)
  return b ? b.profit : null
}

/**
 * Decomposed view of the profit calc with each leg shown in EUR.
 * Returns null when there's nothing meaningful to render. Used by
 * both the Add Car form's live hint and the detail page's profit
 * breakdown row.
 *
 * `liveRate` is the GBP→EUR rate from src/lib/fx.js (cached for
 * 24 hours from api.frankfurter.app). When the per-car snapshot is
 * null this is what's used; otherwise the snapshot wins.
 */
export function profitBreakdown(car, liveRate = null) {
  const saleEur = Number(car?.irish_sale_price_ex_vat || 0)
  const ukExVatGbp = Number(car?.uk_purchase_price_ex_vat || 0)
  if (!saleEur && !ukExVatGbp) return null

  const fx = effectiveFxRate(car, liveRate)
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
    isUsingDefaultFx: isUsingDefaultFx(car, liveRate),
    fxIsCarSnapshot: Number.isFinite(Number(car?.fx_gbp_to_eur)) && Number(car.fx_gbp_to_eur) > 0,
    profit,
  }
}

// ---------------------------------------------------------------------------
// Reporting helpers (pure — used by /cars/reports)
// ---------------------------------------------------------------------------
//
// Aggregates a list of cars into the numbers shown on the Reports tab.
// Pure function, no DB / FX-fetching side-effects — pass the same
// liveRate that the rest of the page uses so every metric reconciles
// against what the user sees on individual car detail pages.

const MS_PER_DAY = 1000 * 60 * 60 * 24

function isInRange(iso, sinceIso) {
  if (!iso) return false
  if (!sinceIso) return true
  return new Date(iso) >= new Date(sinceIso)
}

/**
 * @param {Array} cars  — every car for the location, all statuses.
 * @param {{ liveRate?: number, now?: Date }} [opts]
 * @returns metrics object — see fields below.
 */
export function computeReportMetrics(cars, opts = {}) {
  const list = Array.isArray(cars) ? cars : []
  const liveRate = opts.liveRate ?? null
  const now = opts.now ? new Date(opts.now) : new Date()

  const startOfYear = new Date(now.getFullYear(), 0, 1).toISOString()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  const completed = list.filter(c => c.status === 'completed')
  const active = list.filter(c => c.status === 'new' || c.status === 'pending')

  // ── Cash position ────────────────────────────────────────────────
  // Outstanding UK VAT — every car (active OR completed) where HMRC
  // hasn't paid back yet. Active cars dominate but a completed car
  // with the toggle still off would also still be owed.
  const vatOutstanding = list
    .filter(c => !c.uk_vat_refund_received)
    .reduce((s, c) => s + Number(c.uk_vat || 0), 0)

  const vatRefundedYtd = list
    .filter(c => c.uk_vat_refund_received && isInRange(c.uk_vat_refund_received_at, startOfYear))
    .reduce((s, c) => s + Number(c.uk_vat || 0), 0)

  const vatOutstandingCount = list.filter(c => !c.uk_vat_refund_received && Number(c.uk_vat || 0) > 0).length

  // Active inventory value — cost basis of cars-not-yet-sold, in EUR.
  // Includes UK ex-VAT (converted) plus every ancillary cost already
  // booked against the active car. Tells the operator how much cash
  // is currently parked in the fleet.
  const inventoryValueEur = active.reduce((s, c) => {
    const fx = effectiveFxRate(c, liveRate)
    const uk = Number(c.uk_purchase_price_ex_vat || 0) * fx
    return s + uk + totalAncillaryCosts(c, liveRate)
  }, 0)

  // ── YTD performance (completed cars only) ────────────────────────
  const completedYtd = completed.filter(c => isInRange(c.completed_at, startOfYear))
  const completedMtd = completed.filter(c => isInRange(c.completed_at, startOfMonth))

  const sumProfit = arr => arr.reduce((s, c) => {
    const b = profitBreakdown(c, liveRate)
    return s + (b ? b.profit : 0)
  }, 0)
  const sumRevenue = arr => arr.reduce((s, c) => {
    const split = splitIrishPrice(c)
    return s + (split.salePrice || 0)
  }, 0)

  const revenueYtd = sumRevenue(completedYtd)
  const profitYtd = sumProfit(completedYtd)
  const profitMtd = sumProfit(completedMtd)
  const profitMargin = revenueYtd > 0 ? profitYtd / revenueYtd : null
  const avgProfitPerCar = completedYtd.length ? profitYtd / completedYtd.length : null

  // ── Cycle time ───────────────────────────────────────────────────
  const cycleDays = completedYtd
    .filter(c => c.created_at && c.completed_at)
    .map(c => (new Date(c.completed_at) - new Date(c.created_at)) / MS_PER_DAY)
  const avgCycleDays = cycleDays.length
    ? cycleDays.reduce((s, d) => s + d, 0) / cycleDays.length
    : null

  // ── Cost breakdown YTD (completed cars only — gives a true YTD
  // P&L slice rather than counting half-paid active deals) ──────────
  const costBreakdownYtd = COST_FIELDS.map(f => {
    let totalEur = 0
    for (const c of completedYtd) {
      const v = Number(c[f.key] || 0)
      const fx = effectiveFxRate(c, liveRate)
      totalEur += f.currency === 'GBP' ? v * fx : v
    }
    return { key: f.key, label: f.label, currency: f.currency, totalEur: Math.round(totalEur * 100) / 100 }
  })

  // ── Active fleet breakdown ───────────────────────────────────────
  const newCount = list.filter(c => c.status === 'new').length
  const pendingCount = list.filter(c => c.status === 'pending').length

  return {
    asOf: now.toISOString(),
    cash: {
      vatOutstanding: Math.round(vatOutstanding * 100) / 100,
      vatOutstandingCount,
      vatRefundedYtd: Math.round(vatRefundedYtd * 100) / 100,
      inventoryValueEur: Math.round(inventoryValueEur * 100) / 100,
    },
    ytd: {
      revenue: Math.round(revenueYtd * 100) / 100,
      profit: Math.round(profitYtd * 100) / 100,
      profitMargin,
      avgProfitPerCar: avgProfitPerCar == null ? null : Math.round(avgProfitPerCar * 100) / 100,
      completedCount: completedYtd.length,
    },
    mtd: {
      profit: Math.round(profitMtd * 100) / 100,
      completedCount: completedMtd.length,
    },
    fleet: {
      activeCount: active.length,
      newCount,
      pendingCount,
      avgCycleDays: avgCycleDays == null ? null : Math.round(avgCycleDays * 10) / 10,
    },
    costBreakdownYtd,
  }
}
