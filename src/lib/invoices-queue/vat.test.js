// src/lib/invoices-queue/vat.test.js
import { describe, it, expect } from 'vitest'
import { resolveBillTaxType, hasResolvedVatRate } from './vat'

const RATES = [
  { tax_type: 'NONE', name: 'No VAT', effective_rate: 0, status: 'ACTIVE', can_apply_to_expenses: true },
  { tax_type: 'ZEROEXP', name: 'Zero Rated Purchases', effective_rate: 0, status: 'ACTIVE', can_apply_to_expenses: true },
  { tax_type: 'RED', name: 'VAT on Purchases (13.5%)', effective_rate: 13.5, status: 'ACTIVE', can_apply_to_expenses: true },
  { tax_type: 'INPUT', name: 'VAT on Purchases (23%)', effective_rate: 23, status: 'ACTIVE', can_apply_to_expenses: true },
  { tax_type: 'OUTPUT', name: 'VAT on Sales (23%)', effective_rate: 23, status: 'ACTIVE', can_apply_to_expenses: false },
  { tax_type: 'ARCHIVED23', name: 'Old 23%', effective_rate: 23, status: 'ARCHIVED', can_apply_to_expenses: true },
]

describe('resolveBillTaxType', () => {
  it('zero VAT → NONE (status zero), offering zero-rated alternatives', () => {
    const r = resolveBillTaxType({ subtotal: 100, tax_amount: 0, total: 100 }, RATES)
    expect(r).toMatchObject({ taxType: 'NONE', status: 'zero' })
    expect(r.candidates.map((c) => c.tax_type).sort()).toEqual(['NONE', 'ZEROEXP'])
  })

  it('23% → the unique active expense rate', () => {
    const r = resolveBillTaxType({ subtotal: 100, tax_amount: 23, total: 123 }, RATES)
    expect(r).toMatchObject({ taxType: 'INPUT', status: 'matched' })
  })

  it('13.5% → the reduced rate (not the standard)', () => {
    const r = resolveBillTaxType({ subtotal: 100, tax_amount: 13.5, total: 113.5 }, RATES)
    expect(r.taxType).toBe('RED')
  })

  it('excludes revenue-only + archived rates from matching', () => {
    // Only INPUT is active+expense at 23; OUTPUT (revenue) and ARCHIVED23 excluded → unique.
    const r = resolveBillTaxType({ subtotal: 100, tax_amount: 23, total: 123 }, RATES)
    expect(r.status).toBe('matched')
  })

  it('ambiguous when two active expense rates match the derived rate', () => {
    const rates = [
      { tax_type: 'INPUT', name: 'Purchases 23', effective_rate: 23, status: 'ACTIVE', can_apply_to_expenses: true },
      { tax_type: 'IMPORT', name: 'Imports 23', effective_rate: 23, status: 'ACTIVE', can_apply_to_expenses: true },
    ]
    const r = resolveBillTaxType({ subtotal: 100, tax_amount: 23, total: 123 }, rates)
    expect(r).toMatchObject({ taxType: null, status: 'ambiguous' })
    expect(r.candidates).toHaveLength(2)
  })

  it('unmatched when no active expense rate is within tolerance', () => {
    const r = resolveBillTaxType({ subtotal: 100, tax_amount: 5, total: 105 }, RATES)
    expect(r).toMatchObject({ taxType: null, status: 'unmatched' })
  })

  it('falls back to line-item sum, then total−tax, for net', () => {
    // no subtotal → net from lines (8×3.25 + 7.2 = 33.2); tax 0 → zero
    const r = resolveBillTaxType({ tax_amount: 0, line_items: [{ quantity: 8, unit_amount: 3.25 }, { quantity: 1, unit_amount: 7.2 }] }, RATES)
    expect(r.status).toBe('zero')
  })

  it('within ±0.5pp tolerance rounds to the rate; outside does not', () => {
    expect(resolveBillTaxType({ subtotal: 100, tax_amount: 22.6, total: 122.6 }, RATES).taxType).toBe('INPUT') // 22.6% within 0.5 of 23
    expect(resolveBillTaxType({ subtotal: 100, tax_amount: 22.4, total: 122.4 }, RATES).status).toBe('unmatched') // 22.4% outside
  })

  it('line-item net works when quantity is missing (defaults to 1)', () => {
    // review #3 — a line with no quantity must not poison the sum to NaN.
    // net = 100 (unit_amount, qty defaulted) → 23/100 = 23% → INPUT.
    const r = resolveBillTaxType(
      { tax_amount: 23, line_items: [{ unit_amount: 100 }] }, RATES)
    expect(r.taxType).toBe('INPUT')
    expect(r.status).toBe('matched')
  })

  it('ignores rates with a non-numeric effective_rate (review #4)', () => {
    const rates = [
      { tax_type: 'BROKEN', name: 'No rate', effective_rate: null, status: 'ACTIVE', can_apply_to_expenses: true },
      { tax_type: 'INPUT', name: 'Purchases 23', effective_rate: 23, status: 'ACTIVE', can_apply_to_expenses: true },
    ]
    // 23% bill: the null-rate row must not be coerced to 0 (harmless here)
    // and must not be a candidate; INPUT is the unique match.
    expect(resolveBillTaxType({ subtotal: 100, tax_amount: 23, total: 123 }, rates).taxType).toBe('INPUT')
    // 0% bill: the null-rate row must NOT be offered as a zero candidate.
    const zero = resolveBillTaxType({ subtotal: 100, tax_amount: 0, total: 100 }, rates)
    expect(zero.candidates.map((c) => c.tax_type)).not.toContain('BROKEN')
  })
})

describe('hasResolvedVatRate', () => {
  it('true when a confirmed tax_type is set', () => {
    expect(hasResolvedVatRate({ tax_type: 'INPUT', tax_amount: 23 })).toBe(true)
  })
  it('true for a genuine 0%-VAT bill (tax_amount 0 or null)', () => {
    expect(hasResolvedVatRate({ tax_amount: 0 })).toBe(true)
    expect(hasResolvedVatRate({ tax_amount: null })).toBe(true) // Number(null)===0
  })
  it('false when a non-zero bill has no tax_type', () => {
    expect(hasResolvedVatRate({ tax_amount: 23 })).toBe(false)
    expect(hasResolvedVatRate({ tax_amount: 23, tax_type: '' })).toBe(false)
    expect(hasResolvedVatRate({})).toBe(false) // Number(undefined) is NaN, not 0
    expect(hasResolvedVatRate(null)).toBe(false)
  })
})
