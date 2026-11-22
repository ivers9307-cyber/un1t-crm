import { describe, it, expect } from 'vitest'
import {
  REVIEW_REASONS,
  REVIEW_REASON_LABELS,
  fieldReasons,
  mergeReasons,
  isReady,
} from './readiness.js'

const good = () => ({
  supplier_name: 'Acme',
  invoice_number: 'INV-1',
  invoice_date: '2026-11-01',
  subtotal: 100,
  tax_amount: 23,
  total: 123,
  xero_contact_ref: { kind: 'existing', xero_contact_id: 'c1', name: 'Acme' },
  xero_account_id: 'a1',
  account_code: '400',
  tax_type: 'INPUT23',
})
const matched = { status: 'matched', taxType: 'INPUT23' }
const rates = [
  { tax_type: 'INPUT23', effective_rate: 23, status: 'ACTIVE', can_apply_to_expenses: true },
  { tax_type: 'NONE', effective_rate: 0, status: 'ACTIVE', can_apply_to_expenses: true },
  { tax_type: 'NULLRATE', effective_rate: null, status: 'ACTIVE', can_apply_to_expenses: true },
]
const run = (f, extra = {}) => fieldReasons(f, { vat: matched, rememberedTaxType: null, taxRates: rates, ...extra })

describe('constants', () => {
  it('is frozen, ordered, and every reason has a label', () => {
    expect(Object.isFrozen(REVIEW_REASONS)).toBe(true)
    expect(Object.isFrozen(REVIEW_REASON_LABELS)).toBe(true)
    expect(Object.keys(REVIEW_REASON_LABELS).sort()).toEqual([...REVIEW_REASONS].sort())
    expect(REVIEW_REASONS).toEqual([
      'unreadable', 'duplicate_file', 'duplicate_number', 'already_in_xero', 'credit_note', 'not_an_invoice', 'new_supplier',
      'no_account', 'no_vat_rate', 'vat_differs', 'totals_mismatch', 'missing_date', 'zero_total',
    ])
    expect(REVIEW_REASON_LABELS.vat_differs).toBe('VAT differs from last time')
    expect(REVIEW_REASON_LABELS.totals_mismatch).toBe("Totals don't add up")
  })
})

describe('fieldReasons', () => {
  it('returns [] for a fully coded invoice', () => {
    expect(run(good())).toEqual([])
  })
  it('never throws on null or undefined', () => {
    expect(fieldReasons(null, {})).toEqual([])
    expect(fieldReasons(undefined)).toEqual([])
  })
  it('new_supplier: no contact ref only; kind new does not raise it', () => {
    expect(run({ ...good(), xero_contact_ref: null, xero_account_id: null })).toEqual(['new_supplier'])
    expect(run({ ...good(), xero_contact_ref: undefined })).toContain('new_supplier')
    expect(run({ ...good(), xero_contact_ref: { kind: 'new', name: 'X' } })).toEqual([])
  })
  it('no_account: contact ref but no account', () => {
    expect(run({ ...good(), xero_account_id: '' })).toEqual(['no_account'])
    expect(run({ ...good(), xero_account_id: null })).toEqual(['no_account'])
  })
  it('no_vat_rate: unmatched/ambiguous with empty tax_type', () => {
    expect(run({ ...good(), tax_type: '' }, { vat: { status: 'unmatched' } })).toEqual(['no_vat_rate'])
    expect(run({ ...good(), tax_type: null }, { vat: { status: 'ambiguous' } })).toEqual(['no_vat_rate'])
    expect(run({ ...good(), tax_type: '' }, { vat: { status: 'matched' } })).toEqual([])
  })
  it('no_vat_rate: a chosen tax_type clears it', () => {
    expect(run({ ...good(), tax_type: 'INPUT23' }, { vat: { status: 'unmatched' } })).toEqual([])
  })
  it('no_vat_rate: missing vat counts as unmatched unless tax is zero', () => {
    expect(run({ ...good(), tax_type: '' }, { vat: undefined })).toEqual(['no_vat_rate'])
    expect(run({ ...good(), tax_type: '', tax_amount: 0, total: 100 }, { vat: null })).toEqual([])
  })
  it('vat_differs: zero VAT but remembered a positive rate', () => {
    const f = { ...good(), tax_type: '', tax_amount: 0, total: 100 }
    expect(run(f, { vat: { status: 'zero' }, rememberedTaxType: 'INPUT23' })).toEqual(['vat_differs'])
  })
  it('vat_differs: near misses', () => {
    const f = { ...good(), tax_type: '', tax_amount: 0, total: 100 }
    const z = { status: 'zero' }
    expect(run(f, { vat: z, rememberedTaxType: 'NONE' })).toEqual([])
    expect(run(f, { vat: z, rememberedTaxType: null })).toEqual([])
    expect(run(f, { vat: z, rememberedTaxType: '' })).toEqual([])
    expect(run(f, { vat: z, rememberedTaxType: 'UNKNOWN' })).toEqual([])
    expect(run(f, { vat: z, rememberedTaxType: 'NULLRATE' })).toEqual([])
    expect(run(f, { vat: matched, rememberedTaxType: 'INPUT23' })).toEqual([])
    expect(run({ ...f, tax_type_source: 'manual' }, { vat: z, rememberedTaxType: 'INPUT23' })).toEqual([])
  })
  it('totals_mismatch', () => {
    expect(run({ ...good(), total: 130 })).toEqual(['totals_mismatch'])
    expect(run({ ...good(), total: 123.01 })).toEqual([])
    expect(run({ ...good(), subtotal: 0.1, tax_amount: 0.2, total: 0.3 })).toEqual([])
    expect(run({ ...good(), subtotal: 0, tax_amount: 5, total: 50 })).toEqual([])
    expect(run({ ...good(), subtotal: null, total: 50 })).toEqual([])
    expect(run({ ...good(), tax_amount: undefined, total: 50 })).toEqual([])
  })
  it('missing_date', () => {
    expect(run({ ...good(), invoice_date: '' })).toEqual(['missing_date'])
    expect(run({ ...good(), invoice_date: null })).toEqual(['missing_date'])
  })
  it('zero_total', () => {
    expect(run({ ...good(), subtotal: 0, tax_amount: 0, total: 0 })).toEqual(['zero_total'])
    expect(run({ ...good(), total: 0.5, subtotal: 0.5, tax_amount: 0 })).toEqual([])
  })
  it('never returns caller-owned reasons and keeps REVIEW_REASONS order', () => {
    const r = run({ ...good(), xero_contact_ref: null, invoice_date: '', total: 0, subtotal: 0, tax_amount: 0 })
    expect(r).toEqual(['new_supplier', 'missing_date', 'zero_total'])
  })
})

describe('review round', () => {
  it('zero_total whenever total is unread or zero', () => {
    for (const total of [null, '', 'abc', '0', 0]) {
      expect(run({ ...good(), subtotal: 0, tax_amount: 0, total })).toContain('zero_total')
    }
    expect(run({ ...good(), total: undefined })).toContain('zero_total')
    expect(run({ ...good(), total: 96, subtotal: 96, tax_amount: 0 })).toEqual([])
    expect(run({ ...good(), total: '96.00', subtotal: 96, tax_amount: 0 })).toEqual([])
  })
  it('blank tax_amount raises no_vat_rate even when vat says zero', () => {
    const f = { ...good(), tax_amount: null, total: 100, tax_type: 'NONE', tax_type_source: 'derived' }
    expect(run(f, { vat: { status: 'zero' } })).toContain('no_vat_rate')
    expect(run({ ...f, tax_amount: 'abc' }, { vat: { status: 'zero' } })).toContain('no_vat_rate')
    expect(run({ ...f, tax_type_source: 'manual' }, { vat: { status: 'zero' } })).not.toContain('no_vat_rate')
  })
  it('a receipt with no VAT breakdown is not zero VAT', () => {
    const r = { ...good(), subtotal: 0, tax_amount: 0, total: 96, tax_type: 'NONE' }
    const z = { vat: { status: 'zero' } }
    expect(run({ ...r, tax_type_source: 'derived' }, z)).toEqual(['no_vat_rate'])
    expect(run({ ...r, tax_type_source: 'manual' }, z)).toEqual([])
    expect(run({ ...r, tax_type_source: undefined }, z)).toEqual([])
    expect(run({ ...r, subtotal: 96, tax_type_source: 'derived' }, z)).toEqual([])
    expect(run({ ...good(), tax_type_source: 'derived' })).toEqual([])
  })
  it('credit_note', () => {
    expect(run({ ...good(), document_type: 'credit_note' })).toEqual(['credit_note'])
    for (const t of ['invoice', 'receipt', null, undefined]) {
      expect(run({ ...good(), document_type: t })).toEqual([])
    }
    expect(REVIEW_REASON_LABELS.credit_note).toBe('Credit note')
  })
  it('not_an_invoice for a statement or other document, never Ready', () => {
    expect(run({ ...good(), document_type: 'statement' })).toEqual(['not_an_invoice'])
    expect(run({ ...good(), document_type: 'other' })).toEqual(['not_an_invoice'])
    for (const t of ['invoice', 'receipt', 'credit_note', null, undefined]) {
      expect(run({ ...good(), document_type: t })).not.toContain('not_an_invoice')
    }
    expect(REVIEW_REASON_LABELS.not_an_invoice).toBe('May not be an invoice')
  })
  it('numeric strings, string rates, no taxRates, blank-space date', () => {
    expect(run({ ...good(), subtotal: '100', tax_amount: '23', total: '123.00' })).toEqual([])
    const f = { ...good(), tax_type: '', tax_amount: 0, total: 100 }
    const rs = [{ tax_type: 'INPUT23', effective_rate: '23.0000' }]
    expect(run(f, { vat: { status: 'zero' }, rememberedTaxType: 'INPUT23', taxRates: rs })).toEqual(['vat_differs'])
    expect(() => run(f, { vat: { status: 'zero' }, rememberedTaxType: 'INPUT23', taxRates: undefined })).not.toThrow()
    expect(run({ ...good(), invoice_date: '   ' })).toEqual(['missing_date'])
  })
})

describe('mergeReasons', () => {
  it('dedupes and orders', () => {
    expect(mergeReasons(['zero_total'], ['unreadable', 'zero_total'])).toEqual(['unreadable', 'zero_total'])
  })
  it('ignores null, undefined and unknown strings; returns a new array', () => {
    const a = ['new_supplier']
    const out = mergeReasons(a, null, undefined, ['bogus'])
    expect(out).toEqual(['new_supplier'])
    expect(out).not.toBe(a)
    expect(mergeReasons()).toEqual([])
  })
})

describe('isReady', () => {
  it('is true for empty, null, undefined', () => {
    expect(isReady([])).toBe(true)
    expect(isReady(null)).toBe(true)
    expect(isReady(undefined)).toBe(true)
    expect(isReady(['zero_total'])).toBe(false)
  })
})
