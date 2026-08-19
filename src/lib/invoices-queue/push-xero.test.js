// XERO-API.3 PR 3 — push-xero.js unit coverage.
//
// We lock four things:
//   1. Server-side enforcement of the picker refs — push throws
//      a useful XeroError if xero_account_id / xero_contact_ref
//      are missing on a data_approved row. This is the gate that
//      backs the PR 2 UI gate.
//   2. The state-machine guard — push refuses non-data_approved
//      rows (defence in depth; the route does the same check but
//      we want the lib to be safe in isolation too).
//   3. buildBillPayload — pure builder that stamps the picked
//      account_code on every LineItem.
//   4. Existing-contact branch — when contact_ref.kind='existing',
//      no /Contacts call is made; we go straight to /Invoices.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// xfetch mock — the supabase mock chain returns rows, the xfetch
// mock decides what Xero "returned".
const xfetchMock = vi.fn()
const withFreshTokenMock = vi.fn(async () => ({
  conn: { tenant_id: 't1', tenant_name: 'UN1T Dublin' },
  xfetch: xfetchMock,
}))

vi.mock('@/lib/xero/client', async () => {
  const actual = await vi.importActual('@/lib/xero/client')
  return { ...actual, withFreshToken: withFreshTokenMock }
})

// Supabase chain — tests configure what the SELECT returns by
// reassigning `nextRow` before invoking pushQueueRowToXero.
let nextRow = null
let nextRowError = null
let nextAccounts = [] // rows the xero_accounts tax-type lookup returns
const dbCaptured = { upserts: [], updates: [] }

const mockDb = {
  from: vi.fn((table) => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn(() => Promise.resolve({ data: nextRow, error: nextRowError })),
    // terminal for the account tax-type lookup (.select().eq().in())
    in: vi.fn(() => Promise.resolve({ data: nextAccounts, error: null })),
    upsert: vi.fn((row, opts) => {
      dbCaptured.upserts.push({ table, row, opts })
      return Promise.resolve({ error: null })
    }),
    update: vi.fn((patch) => ({
      eq: vi.fn(() => {
        dbCaptured.updates.push({ table, patch })
        return Promise.resolve({ error: null })
      }),
    })),
  })),
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => mockDb }))

let pushQueueRowToXero, buildBillPayload, findXeroBillByNumber, resolveLineTaxType
beforeEach(async () => {
  vi.resetModules()
  xfetchMock.mockReset()
  withFreshTokenMock.mockClear()
  nextRow = null
  nextRowError = null
  nextAccounts = []
  dbCaptured.upserts = []
  dbCaptured.updates = []
  ;({ pushQueueRowToXero, buildBillPayload, findXeroBillByNumber, resolveLineTaxType } = await import('./push-xero'))
})

// ----- buildBillPayload (pure) -----------------------------

// XERO-BILL-SUMMARY.1 — the bill is ALWAYS one summary line carrying the
// GROSS invoice total, pushed tax-inclusive (LineAmountTypes:'Inclusive'),
// coded to the row account. Itemised line_items are ignored (the PDF is
// attached to the Xero bill), and Xero's booked total always equals the
// captured total.
describe('buildBillPayload', () => {
  it('builds ONE tax-inclusive summary line at the gross total, coded to the row account', () => {
    const payload = buildBillPayload({
      supplier_name: 'Acme',
      invoice_number: 'A001',
      invoice_date: '2026-05-01',
      currency: 'EUR',
      subtotal: 100, tax_amount: 23, total: 123,
      account_code: '400',
      // itemised lines are ignored entirely
      line_items: [
        { description: 'Widget A', quantity: 2, unit_amount: 50 },
        { description: 'Widget B', quantity: 1, unit_amount: 23.45 },
      ],
    }, { supplierContactId: 'C1' })

    expect(payload.Type).toBe('ACCPAY')
    expect(payload.Status).toBe('DRAFT')
    expect(payload.Contact.ContactID).toBe('C1')
    expect(payload.LineAmountTypes).toBe('Inclusive')
    expect(payload.LineItems).toHaveLength(1)
    expect(payload.LineItems[0].Quantity).toBe(1)
    expect(payload.LineItems[0].UnitAmount).toBe(123) // gross total (tax-inclusive)
    expect(payload.LineItems[0].AccountCode).toBe('400')
    expect(payload.LineItems[0].Description).toContain('A001')
    expect(payload.LineItems[0].Description).toContain('Acme')
  })

  it('books the gross total so shipping/fees outside subtotal stay on the bill (ROWfit)', () => {
    // subtotal 149.59 excludes €7.20 shipping; total 156.79 includes it.
    // The line carries the total (156.79), never the subtotal.
    const payload = buildBillPayload({
      supplier_name: 'ROWfit', invoice_number: '23967', invoice_date: '2026-06-09',
      currency: 'EUR', subtotal: 149.59, tax_amount: 0, total: 156.79,
      account_code: '473', line_items: [],
    }, { supplierContactId: 'C1' })
    expect(payload.LineItems).toHaveLength(1)
    expect(payload.LineItems[0].UnitAmount).toBe(156.79)
  })

  it('reconstructs gross from subtotal + tax, then subtotal, when total is absent', () => {
    const fromParts = buildBillPayload(
      { supplier_name: 'S', invoice_number: 'A', subtotal: 100, tax_amount: 23, account_code: '400', line_items: [] },
      { supplierContactId: 'C1' })
    expect(fromParts.LineItems[0].UnitAmount).toBe(123)
    const subOnly = buildBillPayload(
      { supplier_name: 'S', invoice_number: 'A', subtotal: 42, account_code: '400', line_items: [] },
      { supplierContactId: 'C1' })
    expect(subOnly.LineItems[0].UnitAmount).toBe(42)
  })
})

// ----- resolveLineTaxType (pure) + TaxType stamping ---------
//
// XERO-BILL-VAT.1 — the €156.84→€192.91 bug. A 0%-VAT bill sent
// with no TaxType let Xero apply the account's 23% default. We now
// stamp the tax type per line: 'NONE' for zero VAT, the account's
// own cached tax type otherwise.

describe('resolveLineTaxType', () => {
  it("returns 'NONE' whenever the source doc has zero VAT (guards the bug)", () => {
    expect(resolveLineTaxType({ tax_amount: 0 }, { 473: 'INPUT' }, '473')).toBe('NONE')
    // even numeric-string 0 from JSONB, and even when the account
    // would otherwise resolve to a 23% type
    expect(resolveLineTaxType({ tax_amount: '0' }, { 400: 'TAX001' }, '400')).toBe('NONE')
  })

  it("uses the account's own cached tax type when VAT is present", () => {
    expect(resolveLineTaxType({ tax_amount: 23 }, { 400: 'INPUT' }, '400')).toBe('INPUT')
    expect(resolveLineTaxType({ tax_amount: 12.34 }, { 400: 'TAX001' }, '400')).toBe('TAX001')
  })

  it('returns undefined on a cache miss / unknown code (omit → Xero default, no regression)', () => {
    expect(resolveLineTaxType({ tax_amount: 23 }, {}, '999')).toBeUndefined()
    expect(resolveLineTaxType({ tax_amount: 23 }, { 400: 'INPUT' }, null)).toBeUndefined()
  })

  it('does not force NONE when tax_amount is absent (unknown ≠ zero)', () => {
    expect(resolveLineTaxType({}, { 400: 'INPUT' }, '400')).toBe('INPUT')
  })

  it('prefers a confirmed fields.tax_type over everything else', () => {
    // confirmed rate wins even when tax_amount is 0 (would else be NONE)
    // and even when the account cache would resolve something different
    expect(resolveLineTaxType({ tax_amount: 0, tax_type: 'ZEROEXP' }, { 400: 'INPUT' }, '400')).toBe('ZEROEXP')
    expect(resolveLineTaxType({ tax_amount: 23, tax_type: 'RED' }, { 400: 'INPUT' }, '400')).toBe('RED')
  })
})

describe('buildBillPayload — TaxType stamping', () => {
  it("stamps 'NONE' on the summary line for a 0%-VAT bill", () => {
    const payload = buildBillPayload({
      supplier_name: 'ROWfit', invoice_number: '23967', invoice_date: '2026-06-09',
      currency: 'EUR', subtotal: 149.59, tax_amount: 0, total: 156.79,
      account_code: '473', line_items: [],
    }, { supplierContactId: 'C1', accountTaxTypes: { 473: 'INPUT' } })
    expect(payload.LineItems).toHaveLength(1)
    expect(payload.LineItems[0].TaxType).toBe('NONE')
  })

  it("stamps the account's tax type on a standard-rated bill", () => {
    const payload = buildBillPayload({
      supplier_name: 'Acme', invoice_number: 'A1', invoice_date: '2026-05-01',
      currency: 'EUR', subtotal: 100, tax_amount: 23, total: 123,
      account_code: '400', line_items: [],
    }, { supplierContactId: 'C1', accountTaxTypes: { 400: 'INPUT' } })
    expect(payload.LineItems[0].TaxType).toBe('INPUT')
    expect(payload.LineItems[0].UnitAmount).toBe(123) // gross total (tax-inclusive)
  })

  it('omits TaxType entirely when the account is not in the cache', () => {
    const payload = buildBillPayload({
      supplier_name: 'Acme', invoice_number: 'A1', invoice_date: '2026-05-01',
      currency: 'EUR', subtotal: 100, tax_amount: 23, total: 123, account_code: '400',
      line_items: [],
    }, { supplierContactId: 'C1', accountTaxTypes: {} })
    expect('TaxType' in payload.LineItems[0]).toBe(false)
  })

  it('ignores itemised line_items — books at the captured total, not the mis-scaled line sum (Supabase GVVGEG-00005)', () => {
    // The real incident: OCR line_items multiplied out to ~$8,077 for a
    // $35.04 bill ("Realtime Messages - $2.50 per 1,000,000" × 3209). One
    // summary line at net = total − tax = 35.04 is what Xero must receive.
    const payload = buildBillPayload({
      supplier_name: 'Supabase Pte. Ltd.', invoice_number: 'GVVGEG-00005', invoice_date: '2026-07-02',
      currency: 'USD', subtotal: 35.04, tax_amount: 0, total: 35.04,
      tax_type: 'NONE', account_code: '485',
      line_items: [
        { description: 'Realtime Messages - $2.50 per 1,000,000', quantity: 3209, unit_amount: 2.5 },
        { description: 'Pro Plan', quantity: 1, unit_amount: 25 },
      ],
    }, { supplierContactId: 'C1', accountTaxTypes: { 485: 'INPUT' } })
    expect(payload.LineItems).toHaveLength(1)
    expect(payload.LineItems[0].UnitAmount).toBe(35.04)
    expect(payload.LineItems[0].TaxType).toBe('NONE')
  })
})

// ----- pushQueueRowToXero (orchestration) -------------------

describe('pushQueueRowToXero — guard rails', () => {
  it('throws when the row is not in data_approved state', async () => {
    nextRow = {
      id: 'q1', location_id: 'loc1', status: 'extracted',
      source_type: 'supplier_email',
      extracted_fields: { supplier_name: 'Acme', xero_account_id: 'A1', account_code: '400', xero_contact_ref: { kind: 'existing', xero_contact_id: 'C1', name: 'Acme' } },
    }
    await expect(pushQueueRowToXero('q1')).rejects.toThrow(/must be data_approved/)
  })

  it('throws when xero_account_id is missing', async () => {
    nextRow = {
      id: 'q1', location_id: 'loc1', status: 'data_approved',
      source_type: 'supplier_email',
      extracted_fields: {
        supplier_name: 'Acme',
        xero_contact_ref: { kind: 'existing', xero_contact_id: 'C1', name: 'Acme' },
      },
    }
    await expect(pushQueueRowToXero('q1')).rejects.toThrow(/No Xero account picked/)
  })

  it('throws when xero_contact_ref is missing', async () => {
    nextRow = {
      id: 'q1', location_id: 'loc1', status: 'data_approved',
      source_type: 'supplier_email',
      extracted_fields: { supplier_name: 'Acme', xero_account_id: 'A1', account_code: '400' },
    }
    await expect(pushQueueRowToXero('q1')).rejects.toThrow(/No Xero supplier picked/)
  })

  // RECEIPT-NULLS.1 — invoice_date is nullable at extraction now (a till
  // receipt often has no readable date), so this is the backstop: a bill
  // must NOT reach Xero without one. Blocking beats defaulting to the
  // received date — an invented date lands the VAT in the wrong period,
  // and a silent fallback is exactly what CLAUDE.md forbids. The operator
  // fills the date in during the review they already do.
  it('throws when invoice_date is missing — never invents one for Xero', async () => {
    nextRow = {
      id: 'q1', location_id: 'loc1', status: 'data_approved',
      source_type: 'fte_expense_item',
      extracted_fields: {
        supplier_name: 'Tesco Ireland', invoice_number: null, invoice_date: null,
        total: 13.5, xero_account_id: 'A1', account_code: '400',
        xero_contact_ref: { kind: 'existing', xero_contact_id: 'C1', name: 'Tesco' },
      },
    }
    await expect(pushQueueRowToXero('q1')).rejects.toThrow(/no invoice date/i)
  })
})

// RECEIPT-NULLS.1 — Xero's InvoiceNumber/Reference are optional on an
// ACCPAY bill, so a numberless receipt should omit them rather than post
// an explicit null (which Xero stores as the literal string "null" on
// some endpoints). Same conditional-spread idiom the payload already uses
// for DueDate.
describe('buildBillPayload — receipts with no invoice number', () => {
  const base = { supplier_name: 'Tesco Ireland', invoice_date: '2026-07-15', total: 13.5, currency: 'EUR' }

  it('omits InvoiceNumber and Reference entirely when the number is null', () => {
    const payload = buildBillPayload({ ...base, invoice_number: null }, { supplierContactId: 'C1' })
    expect('InvoiceNumber' in payload).toBe(false)
    expect('Reference' in payload).toBe(false)
    expect(payload.Date).toBe('2026-07-15')
  })

  it('still stamps both when the number IS present', () => {
    const payload = buildBillPayload({ ...base, invoice_number: 'INV-9' }, { supplierContactId: 'C1' })
    expect(payload.InvoiceNumber).toBe('INV-9')
    expect(payload.Reference).toBe('INV-9')
  })

  it('describes the line without a dangling "Invoice" when the number is null', () => {
    const payload = buildBillPayload({ ...base, invoice_number: null }, { supplierContactId: 'C1' })
    expect(payload.LineItems[0].Description).toBe('Tesco Ireland')
  })
})

describe('pushQueueRowToXero — happy path (existing contact)', () => {
  it('uses the picked ContactID directly + returns billId + deepLinkUrl', async () => {
    nextRow = {
      id: 'q1', location_id: 'loc1', status: 'data_approved',
      source_type: 'supplier_email',
      extracted_fields: {
        supplier_name: 'Acme', invoice_number: 'A001', invoice_date: '2026-05-01',
        currency: 'EUR', total: 100,
        xero_account_id: 'A1', account_code: '400',
        xero_contact_ref: { kind: 'existing', xero_contact_id: 'C-EXISTING', name: 'Acme' },
        line_items: [{ description: 'thing', quantity: 1, unit_amount: 100 }],
      },
    }
    // First a duplicate-check GET (none found), then the /Invoices
    // POST. No /Contacts lookup (existing contact ref).
    xfetchMock
      .mockResolvedValueOnce({ Invoices: [] })
      .mockResolvedValueOnce({ Invoices: [{ InvoiceID: 'INV-XYZ', InvoiceNumber: 'BILL-0001' }] })

    const r = await pushQueueRowToXero('q1')
    expect(r.billId).toBe('INV-XYZ')
    expect(r.billNumber).toBe('BILL-0001')
    expect(r.deepLinkUrl).toContain('InvoiceID=INV-XYZ')
    expect(r.attachmentError).toBeNull()
    expect(xfetchMock).toHaveBeenCalledTimes(2)
    expect(xfetchMock.mock.calls[0][0]).toContain('/Invoices?where=')
    const postCall = xfetchMock.mock.calls.find((c) => c[0] === '/Invoices')
    expect(postCall[1].body.Invoices[0].Contact.ContactID).toBe('C-EXISTING')
  })
})

// ZERO-TOTAL.1 — a zero total is deliberately NOT blocked on the send. The
// unreadable-total fix lives in the extraction schema (requiredMoney), so no
// new row can carry a phantom zero, and the only €0 rows that have ever been
// pushed are CCF Autos customs SADs — deferred VAT on imported vehicles,
// booked to the "VRT/VAT for Cars" contact, each reviewed by a human hours
// after extraction and forwarded on purpose. This test pins that decision so
// the guard is not "tightened" back in without first establishing that those
// pushes were mistakes.
describe('pushQueueRowToXero — a deliberate zero-total bill still sends', () => {
  it('sends a deferred-VAT customs SAD whose payable total is zero', async () => {
    nextRow = {
      id: 'q1', location_id: 'loc1', status: 'data_approved',
      source_type: 'supplier_email',
      extracted_fields: {
        supplier_name: 'British Car Auctions Ltd', invoice_number: '26IEDUB105BF6K3AR4',
        invoice_date: '2026-04-17', currency: 'EUR',
        subtotal: 13507.33, tax_amount: 0, total: 0,
        xero_account_id: 'A1', account_code: '315',
        xero_contact_ref: { kind: 'existing', xero_contact_id: 'C-VRT', name: 'VRT/VAT for Cars' },
      },
    }
    xfetchMock
      .mockResolvedValueOnce({ Invoices: [] })
      .mockResolvedValueOnce({ Invoices: [{ InvoiceID: 'INV-SAD', InvoiceNumber: '26IEDUB105BF6K3AR4' }] })

    const r = await pushQueueRowToXero('q1')
    expect(r.billId).toBe('INV-SAD')
  })
})

describe('pushQueueRowToXero — 0%-VAT bill books as No VAT (XERO-BILL-VAT.1)', () => {
  it("POSTs TaxType 'NONE' on every line so Xero can't add the account's 23%", async () => {
    nextRow = {
      id: 'q1', location_id: 'loc1', status: 'data_approved',
      source_type: 'supplier_email',
      extracted_fields: {
        supplier_name: 'ROWfit', invoice_number: '23967', invoice_date: '2026-06-09',
        currency: 'EUR', subtotal: 149.59, tax_amount: 0, total: 156.84,
        xero_account_id: 'A473', account_code: '473',
        xero_contact_ref: { kind: 'existing', xero_contact_id: 'C-ROW', name: 'ROWfit' },
        line_items: [
          { description: 'Shock Cord—SkiErg', quantity: 8, unit_amount: 3.25 },
          { description: 'Shipping Cost', quantity: 1, unit_amount: 7.2 },
        ],
      },
    }
    // The account's own default is a 23% purchases type — the fix must
    // NOT let that leak onto a 0%-VAT bill.
    nextAccounts = [{ code: '473', tax_type: 'INPUT' }]
    xfetchMock
      .mockResolvedValueOnce({ Invoices: [] }) // duplicate-check: none
      .mockResolvedValueOnce({ Invoices: [{ InvoiceID: 'INV-ROW', InvoiceNumber: '23967', TotalTax: 0 }] })

    await pushQueueRowToXero('q1')
    const postCall = xfetchMock.mock.calls.find((c) => c[0] === '/Invoices')
    const lines = postCall[1].body.Invoices[0].LineItems
    expect(lines).toHaveLength(1) // XERO-BILL-SUMMARY.1 — one summary line
    expect(lines[0].TaxType).toBe('NONE')
    expect(lines[0].UnitAmount).toBe(156.84) // gross total (tax-inclusive)
    // And the VAT cross-check now corroborates instead of flagging.
    const patch = dbCaptured.updates.find((u) => 'xero_bill_id' in u.patch)?.patch
    expect(patch.xero_total_tax).toBe(0)
    expect(patch.xero_tax_mismatch).toBe(false)
  })
})

describe('pushQueueRowToXero — new contact branch', () => {
  it('upserts via /Contacts then POSTs /Invoices with the new ContactID', async () => {
    nextRow = {
      id: 'q1', location_id: 'loc1', status: 'data_approved',
      source_type: 'supplier_email',
      extracted_fields: {
        supplier_name: 'Brand New Co', invoice_number: 'B001', invoice_date: '2026-05-01',
        currency: 'EUR', total: 50,
        xero_account_id: 'A1', account_code: '400',
        xero_contact_ref: { kind: 'new', name: 'Brand New Co' },
        line_items: [{ description: 'service', quantity: 1, unit_amount: 50 }],
      },
    }
    // Step 1: /Contacts?where=… → no match (empty Contacts).
    // Step 2: POST /Contacts → returns the new ContactID.
    // Step 3: POST /Invoices → returns the bill.
    xfetchMock
      .mockResolvedValueOnce({ Invoices: [] }) // duplicate-check: none
      .mockResolvedValueOnce({ Contacts: [] })
      .mockResolvedValueOnce({ Contacts: [{ ContactID: 'C-NEW' }] })
      .mockResolvedValueOnce({ Invoices: [{ InvoiceID: 'INV-NEW', InvoiceNumber: 'B-0001' }] })

    const r = await pushQueueRowToXero('q1')
    expect(r.billId).toBe('INV-NEW')
    // /Invoices Contact wired to the freshly-created ID.
    const invCall = xfetchMock.mock.calls.find((c) => c[0] === '/Invoices')
    expect(invCall[1].body.Invoices[0].Contact.ContactID).toBe('C-NEW')
    // Local xero_contacts cache backfilled so the next picker
    // fetch finds the new contact without a manual Refresh.
    expect(dbCaptured.upserts.find((u) => u.table === 'xero_contacts')).toBeTruthy()
  })

  it('handles race when contact already exists in Xero (kind=new, but Xero has the same name)', async () => {
    nextRow = {
      id: 'q1', location_id: 'loc1', status: 'data_approved',
      source_type: 'supplier_email',
      extracted_fields: {
        supplier_name: 'Race Co', invoice_number: 'R001', invoice_date: '2026-05-01',
        currency: 'EUR', total: 10,
        xero_account_id: 'A1', account_code: '400',
        xero_contact_ref: { kind: 'new', name: 'Race Co' },
        line_items: [{ description: 'x', quantity: 1, unit_amount: 10 }],
      },
    }
    // Duplicate-check (none), then /Contacts lookup HITS — race-guard.
    xfetchMock
      .mockResolvedValueOnce({ Invoices: [] })
      .mockResolvedValueOnce({ Contacts: [{ ContactID: 'C-ALREADY', Name: 'Race Co', ContactStatus: 'ACTIVE' }] })
      .mockResolvedValueOnce({ Invoices: [{ InvoiceID: 'INV-R', InvoiceNumber: 'R-0001' }] })

    await pushQueueRowToXero('q1')
    // 3 xfetch calls — dup-check + /Contacts lookup + /Invoices POST.
    // No POST to /Contacts because the race-guard found an existing match.
    expect(xfetchMock).toHaveBeenCalledTimes(3)
    expect(xfetchMock.mock.calls.find((c) => c[0] === '/Invoices')).toBeTruthy()
    // The cache still gets the backfill so it knows about the
    // existing contact going forward.
    expect(dbCaptured.upserts.find((u) => u.table === 'xero_contacts')).toBeTruthy()
  })
})

// ----- audit F2 (RCOV.P2): VAT cross-check at push ----------
//
// The immediate-persist update (bill id + deep link) also records
// what Xero booked as tax (TotalTax on the create response) and
// whether it corroborates the OCR-extracted tax_amount within 2c.
// null = not evaluated (either side missing). The retry path (bill
// already created) must never touch these fields.

const f2Row = (taxAmount) => ({
  id: 'q1', location_id: 'loc1', status: 'data_approved',
  source_type: 'supplier_email',
  extracted_fields: {
    supplier_name: 'Acme', invoice_number: 'A001', invoice_date: '2026-05-01',
    currency: 'EUR', total: 123,
    ...(taxAmount !== undefined ? { tax_amount: taxAmount } : {}),
    xero_account_id: 'A1', account_code: '400',
    xero_contact_ref: { kind: 'existing', xero_contact_id: 'C1', name: 'Acme' },
    line_items: [{ description: 'thing', quantity: 1, unit_amount: 100 }],
  },
})

const billPersistPatch = () =>
  dbCaptured.updates.find((u) => u.table === 'invoices_queue' && 'xero_bill_id' in u.patch)?.patch

describe('pushQueueRowToXero — VAT cross-check (audit F2)', () => {
  it('flags a mismatch when Xero books different tax than the OCR read', async () => {
    nextRow = f2Row(23.0)
    xfetchMock
      .mockResolvedValueOnce({ Invoices: [] })
      .mockResolvedValueOnce({ Invoices: [{ InvoiceID: 'I1', InvoiceNumber: 'B1', TotalTax: 19.99 }] })
    await pushQueueRowToXero('q1')
    const patch = billPersistPatch()
    expect(patch.xero_total_tax).toBe(19.99)
    expect(patch.xero_tax_mismatch).toBe(true)
  })

  it('corroborates within the 2c tolerance', async () => {
    nextRow = f2Row(23.005)
    xfetchMock
      .mockResolvedValueOnce({ Invoices: [] })
      .mockResolvedValueOnce({ Invoices: [{ InvoiceID: 'I1', InvoiceNumber: 'B1', TotalTax: 23.0 }] })
    await pushQueueRowToXero('q1')
    const patch = billPersistPatch()
    expect(patch.xero_total_tax).toBe(23.0)
    expect(patch.xero_tax_mismatch).toBe(false)
  })

  it('stores nulls (not evaluated) when the create response has no TotalTax', async () => {
    nextRow = f2Row(23.0)
    xfetchMock
      .mockResolvedValueOnce({ Invoices: [] })
      .mockResolvedValueOnce({ Invoices: [{ InvoiceID: 'I1', InvoiceNumber: 'B1' }] })
    await pushQueueRowToXero('q1')
    const patch = billPersistPatch()
    expect(patch).toHaveProperty('xero_total_tax', null)
    expect(patch).toHaveProperty('xero_tax_mismatch', null)
  })

  it('keeps mismatch null when the OCR tax is missing, but still stores TotalTax', async () => {
    nextRow = f2Row(undefined)
    xfetchMock
      .mockResolvedValueOnce({ Invoices: [] })
      .mockResolvedValueOnce({ Invoices: [{ InvoiceID: 'I1', InvoiceNumber: 'B1', TotalTax: 12.5 }] })
    await pushQueueRowToXero('q1')
    const patch = billPersistPatch()
    expect(patch.xero_total_tax).toBe(12.5)
    expect(patch.xero_tax_mismatch).toBeNull()
  })

  it('retry path (bill already created) never writes tax fields', async () => {
    nextRow = {
      ...f2Row(23.0),
      xero_bill_id: 'INV-OLD',
      xero_bill_number: 'B-OLD',
      xero_deep_link_url: 'https://go.xero.com/x?InvoiceID=INV-OLD',
    }
    const r = await pushQueueRowToXero('q1')
    expect(r.billId).toBe('INV-OLD')
    // Create block skipped entirely: no Xero calls, no bill-persist
    // update, therefore no tax fields written on retry.
    expect(xfetchMock).not.toHaveBeenCalled()
    expect(dbCaptured.updates.find((u) => 'xero_total_tax' in (u.patch || {}))).toBeUndefined()
  })
})

describe('pushQueueRowToXero — duplicate guard', () => {
  it('skips + flags when a bill with the same invoice number already exists in Xero', async () => {
    nextRow = {
      id: 'q1', location_id: 'loc1', status: 'data_approved',
      source_type: 'supplier_email',
      extracted_fields: {
        supplier_name: 'Dupe Co', invoice_number: 'DUP-1', invoice_date: '2026-05-01',
        currency: 'EUR', total: 20,
        xero_account_id: 'A1', account_code: '400',
        xero_contact_ref: { kind: 'existing', xero_contact_id: 'C-1', name: 'Dupe Co' },
        line_items: [{ description: 'x', quantity: 1, unit_amount: 20 }],
      },
    }
    // Duplicate-check GET returns a matching authorised bill.
    xfetchMock.mockResolvedValueOnce({
      Invoices: [{ InvoiceID: 'EXIST', InvoiceNumber: 'DUP-1', Status: 'AUTHORISED' }],
    })
    await expect(pushQueueRowToXero('q1')).rejects.toThrow(/Already in Xero/)
    // No create POST — only the duplicate-check GET ran.
    expect(xfetchMock).toHaveBeenCalledTimes(1)
    expect(xfetchMock.mock.calls.some((c) => c[0] === '/Invoices')).toBe(false)
  })

  it('reuses the stored bill id on retry (idempotent — no create) and re-derives the deep link', async () => {
    nextRow = {
      id: 'q1', location_id: 'loc1', status: 'data_approved',
      source_type: 'supplier_email',
      xero_bill_id: 'INV-PRIOR', xero_bill_number: 'P-1',
      extracted_fields: {
        supplier_name: 'Retry Co', invoice_number: 'RT-1', invoice_date: '2026-05-01',
        currency: 'EUR', total: 20,
        xero_account_id: 'A1', account_code: '400',
        xero_contact_ref: { kind: 'existing', xero_contact_id: 'C-1', name: 'Retry Co' },
        line_items: [{ description: 'x', quantity: 1, unit_amount: 20 }],
      },
    }
    const r = await pushQueueRowToXero('q1')
    expect(r.billId).toBe('INV-PRIOR')
    expect(r.deepLinkUrl).toContain('InvoiceID=INV-PRIOR')
    // No Xero calls at all (no attachment on this row) — never re-creates.
    expect(xfetchMock.mock.calls.some((c) => c[0] === '/Invoices')).toBe(false)
  })
})

describe('findXeroBillByNumber', () => {
  it('returns the matching ACCPAY bill', async () => {
    xfetchMock.mockResolvedValueOnce({ Invoices: [{ InvoiceID: 'X1', InvoiceNumber: 'INV-9', Status: 'AUTHORISED' }] })
    const m = await findXeroBillByNumber(xfetchMock, 'INV-9')
    expect(m.InvoiceID).toBe('X1')
    expect(xfetchMock.mock.calls[0][0]).toContain('/Invoices?where=')
  })
  it('returns null when nothing matches', async () => {
    xfetchMock.mockResolvedValueOnce({ Invoices: [] })
    expect(await findXeroBillByNumber(xfetchMock, 'NOPE')).toBeNull()
  })
  it('returns null (no call) for an empty number', async () => {
    expect(await findXeroBillByNumber(xfetchMock, '')).toBeNull()
    expect(xfetchMock).not.toHaveBeenCalled()
  })
  it('treats a 404 as no match', async () => {
    xfetchMock.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 404 }))
    expect(await findXeroBillByNumber(xfetchMock, 'INV-X')).toBeNull()
  })
})
