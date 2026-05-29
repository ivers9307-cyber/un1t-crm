// INVOICE-OCR.1 — contract tests for the Claude Vision invoice
// extractor's pure logic. The Anthropic API call itself is mocked
// out; we focus on:
//   • the zod schema's coercion + validation behaviour
//   • the markdown-fence stripper
//   • the field-shape boundary cases that come back from Claude
//     in real-world responses
//
// Integration of fetchDocumentAsBase64 + Anthropic round-trip is
// out of scope here — those are I/O paths covered by smoke tests.

import { describe, it, expect } from 'vitest'
import { invoiceFieldsSchema, scoreExtractionConfidence, applyDueDateDefault } from  './invoice-extraction.js'

describe('invoiceFieldsSchema', () => {
  const valid = {
    supplier_name: 'Acme Auto Parts Ltd',
    invoice_number: 'INV-2026-0042',
    invoice_date: '2026-05-17',
    currency: 'EUR',
    subtotal: 100.00,
    tax_amount: 23.00,
    total: 123.00,
    line_items: [
      { description: 'Brake pads', quantity: 2, unit_amount: 50.00 },
    ],
  }

  it('accepts a complete valid payload', () => {
    const r = invoiceFieldsSchema.safeParse(valid)
    expect(r.success).toBe(true)
    expect(r.data.supplier_name).toBe('Acme Auto Parts Ltd')
    expect(r.data.line_items).toHaveLength(1)
  })

  it('coerces string numbers — Claude often quotes them', () => {
    const r = invoiceFieldsSchema.safeParse({
      ...valid,
      subtotal: '100.00',
      tax_amount: '23.00',
      total: '123.00',
      line_items: [{ description: 'X', quantity: '2', unit_amount: '50' }],
    })
    expect(r.success).toBe(true)
    expect(r.data.subtotal).toBe(100)
    expect(r.data.tax_amount).toBe(23)
    expect(r.data.line_items[0].quantity).toBe(2)
  })

  it('defaults currency to EUR when omitted', () => {
    const { currency, ...rest } = valid
    void currency // silence unused destructure
    const r = invoiceFieldsSchema.safeParse(rest)
    expect(r.success).toBe(true)
    expect(r.data.currency).toBe('EUR')
  })

  it('rejects non-ISO invoice_date', () => {
    const r = invoiceFieldsSchema.safeParse({ ...valid, invoice_date: '17/05/2026' })
    expect(r.success).toBe(false)
    expect(r.error.issues[0].message).toMatch(/YYYY-MM-DD/)
  })

  it('rejects non-3-letter currency codes', () => {
    const r = invoiceFieldsSchema.safeParse({ ...valid, currency: 'EURO' })
    expect(r.success).toBe(false)
  })

  it('allows zero line items (the route falls back to a synthetic single line)', () => {
    const r = invoiceFieldsSchema.safeParse({ ...valid, line_items: [] })
    expect(r.success).toBe(true)
    expect(r.data.line_items).toHaveLength(0)
  })

  it('accepts null due_date / supplier_address', () => {
    const r = invoiceFieldsSchema.safeParse({
      ...valid,
      due_date: null,
      supplier_address: null,
    })
    expect(r.success).toBe(true)
  })

  it('accepts a valid ISO due_date', () => {
    const r = invoiceFieldsSchema.safeParse({ ...valid, due_date: '2026-06-30' })
    expect(r.success).toBe(true)
    expect(r.data.due_date).toBe('2026-06-30')
  })

  it('rejects malformed due_date', () => {
    const r = invoiceFieldsSchema.safeParse({ ...valid, due_date: '30 June' })
    expect(r.success).toBe(false)
  })

  it('caps line_items at 200 (defensive — Claude could in theory emit a million)', () => {
    const big = Array.from({ length: 201 }, () => ({ description: 'x', quantity: 1, unit_amount: 1 }))
    const r = invoiceFieldsSchema.safeParse({ ...valid, line_items: big })
    expect(r.success).toBe(false)
  })

  it('preserves account_code on line items when present', () => {
    const r = invoiceFieldsSchema.safeParse({
      ...valid,
      line_items: [{ description: 'X', quantity: 1, unit_amount: 1, account_code: '310' }],
    })
    expect(r.success).toBe(true)
    expect(r.data.line_items[0].account_code).toBe('310')
  })
})

describe('scoreExtractionConfidence', () => {
  const high = { supplier_name: 'Acme', invoice_number: 'INV-1', invoice_date: '2026-05-17', subtotal: 100, tax_amount: 23, total: 123 }

  it('high when all required present and subtotal+tax == total', () => {
    expect(scoreExtractionConfidence(high)).toBe('high')
  })
  it('tolerates a 1-cent rounding difference', () => {
    expect(scoreExtractionConfidence({ ...high, total: 123.009 })).toBe('high')
  })
  it('medium when the maths does not reconcile', () => {
    expect(scoreExtractionConfidence({ ...high, total: 130 })).toBe('medium')
  })
  it('medium when a required field is missing', () => {
    expect(scoreExtractionConfidence({ ...high, invoice_number: '' })).toBe('medium')
    expect(scoreExtractionConfidence({ ...high, supplier_name: undefined })).toBe('medium')
  })
  it('medium when total is not a finite number', () => {
    expect(scoreExtractionConfidence({ ...high, total: 'abc' })).toBe('medium')
  })
  it('never throws on empty/garbage input', () => {
    expect(scoreExtractionConfidence(undefined)).toBe('medium')
    expect(scoreExtractionConfidence({})).toBe('medium')
  })
})

describe('applyDueDateDefault', () => {
  it('fills a missing due_date with issue date + 30 days', () => {
    const out = applyDueDateDefault({ invoice_date: '2026-05-07', due_date: null })
    expect(out.due_date).toBe('2026-06-06')
  })
  it('replaces a due_date that merely echoes the issue date', () => {
    const out = applyDueDateDefault({ invoice_date: '2026-05-07', due_date: '2026-05-07' })
    expect(out.due_date).toBe('2026-06-06')
  })
  it('leaves a genuinely different due_date untouched', () => {
    const out = applyDueDateDefault({ invoice_date: '2026-05-07', due_date: '2026-05-21' })
    expect(out.due_date).toBe('2026-05-21')
  })
  it('handles month/year rollover', () => {
    expect(applyDueDateDefault({ invoice_date: '2026-12-20', due_date: null }).due_date).toBe('2027-01-19')
  })
  it('no-ops when there is no invoice_date', () => {
    const f = { invoice_date: null, due_date: null }
    expect(applyDueDateDefault(f)).toBe(f)
  })
})
