// Coverage for the pure reporting/calc helpers in src/lib/cars.js.
// Heavy DB / FX paths live in the route handlers; this file focuses
// on the maths so we know revenue, profit, VAT outstanding, and
// cycle time numbers stay consistent across UI and reporting.

import { describe, it, expect } from 'vitest'
import {
  computeReportMetrics,
  effectiveFxRate,
  profitBreakdown,
  splitIrishPrice,
  applyIrishVat,
  salePriceToExVat,
  totalAncillaryCosts,
  DEFAULT_GBP_TO_EUR,
  IRISH_VAT_RATE,
} from './cars.js'

const fx = 1.20 // pin so per-test arithmetic is checkable by hand.

function carCompleted(overrides = {}) {
  return {
    status: 'completed',
    uk_purchase_price_ex_vat: 20000,
    uk_vat: 4000,
    uk_vat_refund_received: true,
    uk_vat_refund_received_at: '2026-03-15T00:00:00Z',
    irish_sale_price_ex_vat: 30000,
    irish_sale_price_inc_vat: Math.round(30000 * 1.23 * 100) / 100,
    fx_gbp_to_eur: fx,
    uk_transporter_cost: 500,
    ferry_cost: 300,
    import_customs_cost: 200,
    nct_cost: 50,
    additional_costs: 0,
    created_at: '2026-01-10T00:00:00Z',
    completed_at: '2026-02-09T00:00:00Z', // 30 days
    ...overrides,
  }
}

function carActive(overrides = {}) {
  return {
    status: 'pending',
    uk_purchase_price_ex_vat: 18000,
    uk_vat: 3600,
    uk_vat_refund_received: false,
    irish_sale_price_ex_vat: null,
    irish_sale_price_inc_vat: null,
    fx_gbp_to_eur: fx,
    uk_transporter_cost: 600,
    ferry_cost: 250,
    import_customs_cost: null,
    nct_cost: null,
    additional_costs: null,
    created_at: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

describe('Irish VAT helpers', () => {
  it('applyIrishVat returns ex × 1.23', () => {
    expect(applyIrishVat(10000)).toBe(12300)
    expect(applyIrishVat('')).toBeNull()
    expect(applyIrishVat(null)).toBeNull()
  })

  it('salePriceToExVat is the inverse', () => {
    expect(salePriceToExVat(12300)).toBe(10000)
    expect(salePriceToExVat(null)).toBeNull()
  })

  it('splitIrishPrice prefers stored ex-VAT and recomputes sale', () => {
    const { exVat, vat, salePrice } = splitIrishPrice({
      irish_sale_price_ex_vat: 10000,
      irish_sale_price_inc_vat: 99999, // drift — should be ignored
    })
    expect(exVat).toBe(10000)
    expect(salePrice).toBe(12300)
    expect(vat).toBe(2300)
  })

  it('splitIrishPrice falls back to deriving from sale price', () => {
    const { exVat, vat, salePrice } = splitIrishPrice({
      irish_sale_price_ex_vat: null,
      irish_sale_price_inc_vat: 12300,
    })
    expect(exVat).toBe(10000)
    expect(salePrice).toBe(12300)
    expect(vat).toBe(2300)
  })

  it('IRISH_VAT_RATE is 23%', () => {
    expect(IRISH_VAT_RATE).toBe(0.23)
  })
})

describe('FX rate resolution', () => {
  it('per-car snapshot wins over live rate', () => {
    expect(effectiveFxRate({ fx_gbp_to_eur: 1.18 }, 1.21)).toBe(1.18)
  })
  it('falls back to live rate if no snapshot', () => {
    expect(effectiveFxRate({}, 1.21)).toBe(1.21)
  })
  it('falls back to default when both missing', () => {
    expect(effectiveFxRate({}, null)).toBe(DEFAULT_GBP_TO_EUR)
  })
})

describe('profitBreakdown', () => {
  it('computes EUR profit for a typical completed car', () => {
    const b = profitBreakdown(carCompleted())
    // Sale 30000 − UK ex-VAT 20000×1.20=24000 − £500×1.20=600 − €(300+200+50)=550
    // = 30000 − 24000 − 600 − 550 = 4850
    expect(b.profit).toBe(4850)
    expect(b.fx).toBe(fx)
    expect(b.ukExVatEur).toBe(24000)
  })

  it('returns null when both sides are empty', () => {
    expect(profitBreakdown({ uk_purchase_price_ex_vat: 0, irish_sale_price_ex_vat: 0 })).toBeNull()
  })
})

describe('totalAncillaryCosts', () => {
  it('sums GBP + EUR lines into EUR via the FX rate', () => {
    // 500 GBP × 1.20 + 300 + 200 + 50 + 0 = 600 + 550 = 1150
    expect(totalAncillaryCosts(carCompleted())).toBe(1150)
  })
})

describe('computeReportMetrics', () => {
  // Pin "now" to mid-April 2026 so MTD/YTD windows are deterministic.
  const NOW = new Date('2026-04-15T00:00:00Z')

  it('returns zeroed metrics for an empty fleet', () => {
    const m = computeReportMetrics([], { liveRate: fx, now: NOW })
    expect(m.cash.vatOutstanding).toBe(0)
    expect(m.cash.vatOutstandingCount).toBe(0)
    expect(m.fleet.activeCount).toBe(0)
    expect(m.ytd.completedCount).toBe(0)
    expect(m.fleet.avgCycleDays).toBeNull()
  })

  it('sums VAT outstanding only on cars without refund received', () => {
    const cars = [
      carCompleted(), // refunded
      carActive(),    // owed 3600
      carActive({ uk_vat: 5000 }), // owed 5000
    ]
    const m = computeReportMetrics(cars, { liveRate: fx, now: NOW })
    expect(m.cash.vatOutstanding).toBe(8600)
    expect(m.cash.vatOutstandingCount).toBe(2)
  })

  it('counts VAT refunded in current calendar year only', () => {
    const cars = [
      carCompleted({ uk_vat_refund_received_at: '2025-12-31T00:00:00Z' }), // last year
      carCompleted({ uk_vat: 4500, uk_vat_refund_received_at: '2026-01-05T00:00:00Z' }),
      carCompleted({ uk_vat: 3000, uk_vat_refund_received_at: '2026-04-01T00:00:00Z' }),
    ]
    const m = computeReportMetrics(cars, { liveRate: fx, now: NOW })
    expect(m.cash.vatRefundedYtd).toBe(7500) // 4500 + 3000
  })

  it('YTD revenue + profit reflect only completed cars in the current year', () => {
    const cars = [
      carCompleted(), // 30000 sale ex-VAT → 36900 inc-VAT, profit 4850
      carCompleted({
        // last year — excluded
        completed_at: '2025-11-01T00:00:00Z',
      }),
      carActive(), // not completed — excluded
    ]
    const m = computeReportMetrics(cars, { liveRate: fx, now: NOW })
    expect(m.ytd.completedCount).toBe(1)
    expect(m.ytd.revenue).toBe(36900) // sale price inc VAT
    expect(m.ytd.profit).toBe(4850)
    expect(m.ytd.profitMargin).toBeCloseTo(4850 / 36900, 4)
    expect(m.ytd.avgProfitPerCar).toBe(4850)
  })

  it('MTD profit only counts cars completed inside the current month', () => {
    const cars = [
      carCompleted({ completed_at: '2026-04-05T00:00:00Z' }), // this month
      carCompleted({ completed_at: '2026-03-25T00:00:00Z' }), // last month
    ]
    const m = computeReportMetrics(cars, { liveRate: fx, now: NOW })
    expect(m.mtd.completedCount).toBe(1)
    expect(m.mtd.profit).toBe(4850)
    expect(m.ytd.completedCount).toBe(2) // both inside YTD
  })

  it('inventory value sums purchase + ancillaries on active cars only', () => {
    const cars = [
      carActive(), // 18000×1.2 + 600×1.2 + 250 = 21600 + 720 + 250 = 22570
      carCompleted(), // excluded — already sold
    ]
    const m = computeReportMetrics(cars, { liveRate: fx, now: NOW })
    expect(m.cash.inventoryValueEur).toBe(22570)
  })

  it('avg cycle days uses (completed_at − created_at) over completed YTD', () => {
    const cars = [
      carCompleted({ created_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-21T00:00:00Z' }), // 20d
      carCompleted({ created_at: '2026-02-01T00:00:00Z', completed_at: '2026-02-11T00:00:00Z' }), // 10d
    ]
    const m = computeReportMetrics(cars, { liveRate: fx, now: NOW })
    expect(m.fleet.avgCycleDays).toBe(15)
  })

  it('cost breakdown YTD sums each line in EUR', () => {
    const cars = [
      carCompleted(),
      carCompleted({
        uk_transporter_cost: 1000, ferry_cost: 100, import_customs_cost: 0,
        nct_cost: 0, additional_costs: 250,
      }),
    ]
    const m = computeReportMetrics(cars, { liveRate: fx, now: NOW })
    const transporter = m.costBreakdownYtd.find(c => c.key === 'uk_transporter_cost')
    const ferry = m.costBreakdownYtd.find(c => c.key === 'ferry_cost')
    const commission = m.costBreakdownYtd.find(c => c.key === 'additional_costs')
    expect(transporter.totalEur).toBe(1800) // (500 + 1000) × 1.20
    expect(ferry.totalEur).toBe(400)        // 300 + 100
    expect(commission.totalEur).toBe(250)   // 0 + 250
  })

  it('counts active fleet split by status', () => {
    const cars = [
      carActive({ status: 'new' }),
      carActive({ status: 'pending' }),
      carActive({ status: 'pending' }),
      carCompleted(),
    ]
    const m = computeReportMetrics(cars, { liveRate: fx, now: NOW })
    expect(m.fleet.activeCount).toBe(3)
    expect(m.fleet.newCount).toBe(1)
    expect(m.fleet.pendingCount).toBe(2)
  })
})
