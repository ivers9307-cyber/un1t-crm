import { describe, it, expect } from 'vitest'
import { mapPayableInvoices, daysOverdue, bucketFor, agePayables } from './aged-payables'

const payload = {
  Invoices: [
    { Type: 'ACCPAY', Status: 'AUTHORISED', InvoiceID: 'i1', InvoiceNumber: 'INV-1', Contact: { ContactID: 'c1', Name: 'Muscle Foods' }, DateString: '2026-04-01T00:00:00', DueDateString: '2026-04-15T00:00:00', AmountDue: 100, CurrencyCode: 'EUR' },
    { Type: 'ACCPAY', Status: 'PAID', InvoiceID: 'i2', Contact: { Name: 'Paid Co' }, DueDateString: '2026-05-01T00:00:00', AmountDue: 0 }, // PAID → skip
    { Type: 'ACCREC', Status: 'AUTHORISED', InvoiceID: 'i3', Contact: { Name: 'A Customer' }, DueDateString: '2026-05-01T00:00:00', AmountDue: 500 }, // sales invoice → skip
    { Type: 'ACCPAY', Status: 'AUTHORISED', InvoiceID: 'i4', Contact: { ContactID: 'c1', Name: 'Muscle Foods' }, DueDateString: '2026-06-20T00:00:00', AmountDue: 50, CurrencyCode: 'EUR' },
    { Type: 'ACCPAY', Status: 'AUTHORISED', InvoiceID: 'i5', Contact: { ContactID: 'c2', Name: 'Electric Ireland' }, DueDateString: '2026-07-30T00:00:00', AmountDue: 230 }, // not due yet
    { Type: 'ACCPAY', Status: 'AUTHORISED', InvoiceID: 'i6', Contact: { Name: 'No Due' }, Date: '/Date(1780272000000+0000)/', AmountDue: 12 }, // legacy date, no due date
  ],
}

describe('mapPayableInvoices', () => {
  it('keeps only unpaid AUTHORISED ACCPAY bills with positive AmountDue', () => {
    const rows = mapPayableInvoices(payload)
    expect(rows.map((r) => r.invoiceId)).toEqual(['i1', 'i4', 'i5', 'i6'])
    expect(rows[0]).toMatchObject({ contactName: 'Muscle Foods', dueDate: '2026-04-15', amountDue: 100, invoiceNumber: 'INV-1' })
    // legacy /Date(ms)/ parses for the bill date; missing due date → ''
    expect(rows[3].dueDate).toBe('')
  })
  it('returns [] for empty/odd payloads', () => {
    expect(mapPayableInvoices({})).toEqual([])
    expect(mapPayableInvoices(null)).toEqual([])
  })
})

describe('daysOverdue / bucketFor', () => {
  it('computes whole-day overdue and ladders correctly', () => {
    expect(daysOverdue('2026-06-01', '2026-07-05')).toBe(34)
    expect(daysOverdue('2026-07-05', '2026-07-05')).toBe(0)
    expect(daysOverdue('2026-07-30', '2026-07-05')).toBe(-25)
    expect(daysOverdue('bad', '2026-07-05')).toBeNull()
  })
  it('buckets by the standard ladder', () => {
    expect(bucketFor(-5)).toBe('not_due')
    expect(bucketFor(0)).toBe('not_due')
    expect(bucketFor(1)).toBe('d1_30')
    expect(bucketFor(30)).toBe('d1_30')
    expect(bucketFor(31)).toBe('d31_60')
    expect(bucketFor(90)).toBe('d61_90')
    expect(bucketFor(91)).toBe('d90_plus')
    expect(bucketFor(null)).toBe('not_due')
  })
})

describe('agePayables', () => {
  const today = '2026-07-05'
  it('aggregates per supplier, buckets, totals, and sorts most-overdue first', () => {
    const { suppliers, totals, supplierCount } = agePayables(mapPayableInvoices(payload), today)
    expect(supplierCount).toBe(3) // Muscle Foods (2 bills), Electric Ireland, No Due

    // Muscle Foods: €100 due 2026-04-15 (81d → 61_90) + €50 due 2026-06-20 (15d → 1_30) = €150, overdue €150
    const mf = suppliers.find((s) => s.contactName === 'Muscle Foods')
    expect(mf.total).toBe(150)
    expect(mf.overdue).toBe(150)
    expect(mf.buckets.d61_90).toBe(100)
    expect(mf.buckets.d1_30).toBe(50)
    expect(mf.oldestDays).toBe(daysOverdue('2026-04-15', today)) // 81

    // Electric Ireland: not due yet → overdue 0, sits in not_due
    const ei = suppliers.find((s) => s.contactName === 'Electric Ireland')
    expect(ei.overdue).toBe(0)
    expect(ei.buckets.not_due).toBe(230)

    // Muscle Foods (oldest 81d) ranks first; not-due Electric Ireland last-ish
    expect(suppliers[0].contactName).toBe('Muscle Foods')

    // whole-board totals
    expect(totals.total).toBe(392) // 100+50+230+12
    expect(totals.overdue).toBe(150) // only Muscle Foods bills are past due
    expect(totals.not_due).toBe(242) // 230 (electric) + 12 (no-due bill → not_due)
    expect(totals.billCount).toBe(4)
  })
})
