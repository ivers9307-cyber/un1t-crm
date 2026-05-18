// INVOICE-OCR.1 — pure-logic tests for the Xero draft-bill builder.
//
// buildBillPayload is the only pure function in draft-bills.js —
// the upsertSupplierContact + pushExtractedInvoiceToXero pieces
// are integration-shaped (real Xero API calls). The payload
// builder is where the data-shape contract lives, so it gets the
// most pinning.

import { describe, it, expect } from 'vitest'
import { buildBillPayload } from './draft-bills.js'

const baseFields = {
  supplier_name: 'Acme Auto Parts Ltd',
  invoice_number: 'INV-42',
  invoice_date: '2026-05-17',
  due_date: '2026-06-16',
  currency: 'EUR',
  subtotal: 100,
  tax_amount: 23,
  total: 123,
  line_items: [
    { description: 'Brake pads', quantity: 2, unit_amount: 50 },
  ],
}

describe('buildBillPayload', () => {
  it('produces a draft ACCPAY invoice with the supplier reference', () => {
    const p = buildBillPayload(baseFields, { supplierContactId: 'contact-uuid-123' })
    expect(p.Type).toBe('ACCPAY')
    expect(p.Status).toBe('DRAFT')
    expect(p.Contact).toEqual({ ContactID: 'contact-uuid-123' })
    expect(p.InvoiceNumber).toBe('INV-42')
    expect(p.Reference).toBe('INV-42')
    expect(p.Date).toBe('2026-05-17')
    expect(p.DueDate).toBe('2026-06-16')
    expect(p.CurrencyCode).toBe('EUR')
    expect(p.LineAmountTypes).toBe('Exclusive')
  })

  it('omits DueDate when due_date is absent', () => {
    const { due_date, ...rest } = baseFields
    void due_date
    const p = buildBillPayload(rest, { supplierContactId: 'c1' })
    expect(p).not.toHaveProperty('DueDate')
  })

  it('falls back to a single synthetic line when line_items is empty', () => {
    const p = buildBillPayload({ ...baseFields, line_items: [] }, { supplierContactId: 'c1' })
    expect(p.LineItems).toHaveLength(1)
    expect(p.LineItems[0].Description).toMatch(/INV-42/)
    expect(p.LineItems[0].Description).toMatch(/Acme Auto Parts Ltd/)
    // Synthetic fallback uses subtotal as the line amount.
    expect(p.LineItems[0].UnitAmount).toBe(100)
  })

  it('maps line items 1:1 with the source array', () => {
    const p = buildBillPayload({
      ...baseFields,
      line_items: [
        { description: 'A', quantity: 1, unit_amount: 10 },
        { description: 'B', quantity: 3, unit_amount: 7 },
      ],
    }, { supplierContactId: 'c1' })
    expect(p.LineItems).toHaveLength(2)
    expect(p.LineItems[0]).toMatchObject({ Description: 'A', Quantity: 1, UnitAmount: 10 })
    expect(p.LineItems[1]).toMatchObject({ Description: 'B', Quantity: 3, UnitAmount: 7 })
  })

  it('includes AccountCode only when present on the line', () => {
    const p = buildBillPayload({
      ...baseFields,
      line_items: [
        { description: 'with-code', quantity: 1, unit_amount: 1, account_code: '310' },
        { description: 'without-code', quantity: 1, unit_amount: 1 },
      ],
    }, { supplierContactId: 'c1' })
    expect(p.LineItems[0].AccountCode).toBe('310')
    expect(p.LineItems[1]).not.toHaveProperty('AccountCode')
  })

  it('replaces blank descriptions with a placeholder (Xero rejects empty)', () => {
    const p = buildBillPayload({
      ...baseFields,
      line_items: [{ description: '', quantity: 1, unit_amount: 1 }],
    }, { supplierContactId: 'c1' })
    expect(p.LineItems[0].Description).toBe('(no description)')
  })

  it('truncates absurdly long descriptions to Xero limits', () => {
    const longDesc = 'x'.repeat(5000)
    const p = buildBillPayload({
      ...baseFields,
      line_items: [{ description: longDesc, quantity: 1, unit_amount: 1 }],
    }, { supplierContactId: 'c1' })
    expect(p.LineItems[0].Description.length).toBe(4000)
  })

  it('falls back to EUR currency when source omits it (defensive — schema defaults too)', () => {
    const { currency, ...rest } = baseFields
    void currency
    const p = buildBillPayload(rest, { supplierContactId: 'c1' })
    expect(p.CurrencyCode).toBe('EUR')
  })

  it('coerces line quantity / unit_amount to numbers', () => {
    const p = buildBillPayload({
      ...baseFields,
      line_items: [{ description: 'x', quantity: '2', unit_amount: '7.50' }],
    }, { supplierContactId: 'c1' })
    expect(p.LineItems[0].Quantity).toBe(2)
    expect(p.LineItems[0].UnitAmount).toBe(7.5)
  })
})
