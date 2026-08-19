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
import { invoiceFieldsSchema, scoreExtractionConfidence, applyDueDateDefault, sniffMimeFromBytes } from  './invoice-extraction.js'

// RECEIPT-NULLS.1 — a till receipt is not an invoice. It routinely has no
// invoice number, and often no date the model can read off a crumpled
// thermal print. Both fields were non-nullable, so Claude correctly
// answering `null` failed schema validation and the ENTIRE extraction was
// discarded — the operator got "Extracted JSON failed schema validation"
// and no data at all, on a receipt whose supplier and total were read
// perfectly. Live twice: a Tesco receipt (invoice_date, queue row
// ee83a2f6) and a card receipt (invoice_number, e216cb1b, June).
//
// The system was already designed for this: scoreExtractionConfidence
// downgrades a payload missing either field to 'medium', and the extract
// route's comment says "Operator always reviews regardless". The schema
// was simply stricter than the pipeline it feeds.
describe('invoiceFieldsSchema — receipts with no number or date', () => {
  const receipt = {
    supplier_name: 'Tesco Ireland',
    invoice_number: null,
    invoice_date: null,
    currency: 'EUR',
    subtotal: 13.50,
    tax_amount: 0,
    total: 13.50,
    line_items: [{ description: 'Energizer Max D Batteries 4 Pack', quantity: 1, unit_amount: 13.50 }],
  }

  it('accepts a null invoice_date (the Tesco receipt)', () => {
    const r = invoiceFieldsSchema.safeParse({ ...receipt, invoice_number: 'T-1' })
    expect(r.success).toBe(true)
    expect(r.data.invoice_date).toBeNull()
  })

  it('accepts a null invoice_number (the June card receipt)', () => {
    const r = invoiceFieldsSchema.safeParse({ ...receipt, invoice_date: '2026-07-15' })
    expect(r.success).toBe(true)
    expect(r.data.invoice_number).toBeNull()
  })

  it('accepts both null at once, keeping the fields it DID read', () => {
    const r = invoiceFieldsSchema.safeParse(receipt)
    expect(r.success).toBe(true)
    expect(r.data.supplier_name).toBe('Tesco Ireland')
    expect(r.data.total).toBe(13.5)
  })

  it('still rejects a malformed date — nullable is not "anything goes"', () => {
    const r = invoiceFieldsSchema.safeParse({ ...receipt, invoice_date: '15 Jul 2026' })
    expect(r.success).toBe(false)
  })

  it('still requires supplier_name — a receipt with no vendor is unusable', () => {
    const r = invoiceFieldsSchema.safeParse({ ...receipt, supplier_name: null })
    expect(r.success).toBe(false)
  })

  it('lands at medium confidence, which is what routes the operator to it', () => {
    expect(scoreExtractionConfidence(receipt)).toBe('medium')
  })
})

// MIME-SNIFF.1 — the stored mime cannot be trusted, so read the bytes.
// enqueue.js hard-coded 'application/pdf' for every contractor invoice
// (its source column is literally named pdf_path), so James Barr's phone
// photo was sent to Anthropic inside a `document` block and came back
// "The PDF specified was not valid" (400). Sniffing here fixes the class
// for EVERY source, not just the one that was wrong.
describe('sniffMimeFromBytes', () => {
  const bytes = (...n) => Buffer.from(n)

  it('detects a PNG', () => {
    expect(sniffMimeFromBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toBe('image/png')
  })

  it('detects a JPEG', () => {
    expect(sniffMimeFromBytes(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe('image/jpeg')
  })

  it('detects a PDF', () => {
    expect(sniffMimeFromBytes(Buffer.from('%PDF-1.7\n%âãÏÓ'))).toBe('application/pdf')
  })

  it('detects a GIF', () => {
    expect(sniffMimeFromBytes(Buffer.from('GIF89a....'))).toBe('image/gif')
  })

  it('detects a WebP (RIFF container — the WEBP tag is at byte 8)', () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
    expect(sniffMimeFromBytes(webp)).toBe('image/webp')
  })

  it('does NOT mistake a RIFF wav for a WebP', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WAVEfmt ')])
    expect(sniffMimeFromBytes(wav)).toBeNull()
  })

  it('returns null for something it cannot identify, rather than guessing', () => {
    expect(sniffMimeFromBytes(Buffer.from('just some text'))).toBeNull()
    expect(sniffMimeFromBytes(Buffer.alloc(0))).toBeNull()
    expect(sniffMimeFromBytes(null)).toBeNull()
  })
})

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
