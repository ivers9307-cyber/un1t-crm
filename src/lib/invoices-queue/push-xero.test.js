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
const dbCaptured = { upserts: [], updates: [] }

const mockDb = {
  from: vi.fn((table) => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn(() => Promise.resolve({ data: nextRow, error: nextRowError })),
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

let pushQueueRowToXero, buildBillPayload
beforeEach(async () => {
  vi.resetModules()
  xfetchMock.mockReset()
  withFreshTokenMock.mockClear()
  nextRow = null
  nextRowError = null
  dbCaptured.upserts = []
  dbCaptured.updates = []
  ;({ pushQueueRowToXero, buildBillPayload } = await import('./push-xero'))
})

// ----- buildBillPayload (pure) -----------------------------

describe('buildBillPayload', () => {
  it('stamps AccountCode on every line from the row-level account_code', () => {
    const payload = buildBillPayload({
      supplier_name: 'Acme',
      invoice_number: 'A001',
      invoice_date: '2026-05-01',
      currency: 'EUR',
      total: 123.45,
      account_code: '400',
      line_items: [
        { description: 'Widget A', quantity: 2, unit_amount: 50 },
        { description: 'Widget B', quantity: 1, unit_amount: 23.45 },
      ],
    }, { supplierContactId: 'C1' })

    expect(payload.Type).toBe('ACCPAY')
    expect(payload.Status).toBe('DRAFT')
    expect(payload.Contact.ContactID).toBe('C1')
    expect(payload.LineItems).toHaveLength(2)
    expect(payload.LineItems[0].AccountCode).toBe('400')
    expect(payload.LineItems[1].AccountCode).toBe('400')
  })

  it('honours per-line account_code overrides over the row default', () => {
    const payload = buildBillPayload({
      supplier_name: 'Acme',
      invoice_number: 'A001',
      invoice_date: '2026-05-01',
      currency: 'EUR',
      account_code: '400',
      line_items: [
        { description: 'Default', quantity: 1, unit_amount: 10 },
        { description: 'Override', quantity: 1, unit_amount: 5, account_code: '410' },
      ],
    }, { supplierContactId: 'C1' })
    expect(payload.LineItems[0].AccountCode).toBe('400')
    expect(payload.LineItems[1].AccountCode).toBe('410')
  })

  it('synthesises a single line when line_items is empty', () => {
    const payload = buildBillPayload({
      supplier_name: 'Acme',
      invoice_number: 'A001',
      invoice_date: '2026-05-01',
      total: 99,
      account_code: '400',
      line_items: [],
    }, { supplierContactId: 'C1' })
    expect(payload.LineItems).toHaveLength(1)
    expect(payload.LineItems[0].UnitAmount).toBe(99)
    expect(payload.LineItems[0].AccountCode).toBe('400')
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
    // Only the /Invoices POST should hit Xero — no /Contacts lookup.
    xfetchMock.mockResolvedValueOnce({
      Invoices: [{ InvoiceID: 'INV-XYZ', InvoiceNumber: 'BILL-0001' }],
    })

    const r = await pushQueueRowToXero('q1')
    expect(r.billId).toBe('INV-XYZ')
    expect(r.billNumber).toBe('BILL-0001')
    expect(r.deepLinkUrl).toContain('InvoiceID=INV-XYZ')
    expect(xfetchMock).toHaveBeenCalledTimes(1)
    expect(xfetchMock.mock.calls[0][0]).toBe('/Invoices')
    expect(xfetchMock.mock.calls[0][1].body.Invoices[0].Contact.ContactID).toBe('C-EXISTING')
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
    // /Contacts lookup HITS — race-guard path.
    xfetchMock
      .mockResolvedValueOnce({ Contacts: [{ ContactID: 'C-ALREADY', Name: 'Race Co', ContactStatus: 'ACTIVE' }] })
      .mockResolvedValueOnce({ Invoices: [{ InvoiceID: 'INV-R', InvoiceNumber: 'R-0001' }] })

    await pushQueueRowToXero('q1')
    // Only 2 xfetch calls — no POST to /Contacts because the race-
    // guard found an existing match.
    expect(xfetchMock).toHaveBeenCalledTimes(2)
    expect(xfetchMock.mock.calls[1][0]).toBe('/Invoices')
    // The cache still gets the backfill so it knows about the
    // existing contact going forward.
    expect(dbCaptured.upserts.find((u) => u.table === 'xero_contacts')).toBeTruthy()
  })
})
