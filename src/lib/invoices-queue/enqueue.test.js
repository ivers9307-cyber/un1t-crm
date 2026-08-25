// INVOICES-QUEUE.1 — enqueue test coverage.
//
// The enqueue helpers are thin orchestrators around supabase-js;
// the integration story (mig 185 CHECK constraint enforces source
// xor, FK cascade cleans queue on source delete) is left to
// route-level + DB integration tests. Here we lock the SHAPE of
// each function's output and the error-envelope contract — the
// approval routes use the {ok,error} shape to decide whether to
// surface a warning, so a shape regression silently breaks the
// caller pattern.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Stub the Supabase server client BEFORE importing the lib so
// `enqueueFromX` picks up the stub instead of the real one.
const mockDb = {
  from: vi.fn(),
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => mockDb }))

// Helper to build a fluent chainable mock that resolves to a
// fixed value at the end of the chain. supabase-js's
// PostgrestQueryBuilder + Filter + Transform builders are
// thenables — `await db.from(...).select(...).eq(...).maybeSingle()`
// resolves the chain. We stub each step to return `this` (the same
// chainable) plus a final `.then`/`.maybeSingle`/`.single` that
// resolves.
function buildChainable(finalValue) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(finalValue),
    single: vi.fn().mockResolvedValue(finalValue),
    insert: vi.fn().mockReturnThis(),
    then: undefined, // not awaited at the top level
  }
  return chain
}

let enqueueModule

beforeEach(async () => {
  vi.resetModules()
  mockDb.from.mockReset()
  // CONTRACTOR-MIME.1 — the contractor path now reads Storage metadata, and
  // its tests attach a `storage` stub per case. Clear it here so a stub can
  // never leak into a test that means to exercise the no-Storage fallback.
  delete mockDb.storage
  enqueueModule = await import('./enqueue')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('enqueueFromFteExpenseClaim', () => {
  it('returns ok with empty queueIds when claim has no items', async () => {
    // First .from('fte_expense_claims') call returns the claim row.
    // Second .from('fte_expense_items') call returns an empty array.
    const claimChain = buildChainable({ data: { id: 'c1', location_id: 'loc1', status: 'approved' }, error: null })
    const itemsChain = buildChainable({ data: [], error: null })
    mockDb.from.mockImplementation((table) => {
      if (table === 'fte_expense_claims') return claimChain
      if (table === 'fte_expense_items') return itemsChain
      throw new Error(`unexpected table ${table}`)
    })
    const r = await enqueueModule.enqueueFromFteExpenseClaim('c1')
    expect(r).toEqual({ ok: true, queueIds: [] })
  })

  // RECEIPTLESS-EXPENSE-QUEUE — receiptless items used to be dropped
  // on the floor. Now they get queued with status='extracted' and
  // synthetic extracted_fields so the bookkeeper can still review
  // + send to Xero. Lock that contract here.
  it('queues receiptless items pre-extracted with synthetic fields', async () => {
    // Bespoke chainable that's actually thenable for the items
    // fetch — the shared buildChainable() has `then: undefined`
    // which makes awaits short-circuit (existing tests rely on
    // that quirk; we don't here).
    const itemsResult = {
      data: [
        { id: 'i1', claim_id: 'c1', receipt_path: null, vendor: 'Mileage', amount: 12.34, expense_date: '2026-05-20' },
      ],
      error: null,
    }
    const itemsChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn(() => Promise.resolve(itemsResult)),
    }
    const claimChain = buildChainable({ data: { id: 'c1', location_id: 'loc1', status: 'approved' }, error: null })
    const insertedRows = []
    const queueChain = {
      insert: vi.fn((rows) => {
        insertedRows.push(...rows)
        return queueChain
      }),
      select: vi.fn().mockResolvedValue({ data: [{ id: 'q-new' }], error: null }),
    }
    mockDb.from.mockImplementation((t) => {
      if (t === 'fte_expense_claims') return claimChain
      if (t === 'fte_expense_items') return itemsChain
      if (t === 'invoices_queue') return queueChain
      throw new Error(`unexpected table ${t}`)
    })

    const r = await enqueueModule.enqueueFromFteExpenseClaim('c1')
    expect(r).toEqual({ ok: true, queueIds: ['q-new'] })
    expect(insertedRows).toHaveLength(1)
    const row = insertedRows[0]
    expect(row.status).toBe('extracted')
    expect(row.attachment_path).toBeNull()
    expect(row.attachment_bucket).toBe('fte-expense-receipts')
    expect(row.extracted_fields).toMatchObject({
      supplier_name: 'Mileage',
      invoice_date: '2026-05-20',
      currency: 'EUR',
      total: 12.34,
      subtotal: 12.34,
      tax_amount: 0,
    })
    expect(row.extracted_fields.invoice_number).toMatch(/^EXP-/)
    expect(row.extracted_fields.line_items).toHaveLength(1)
    expect(row.subject).toMatch(/no receipt/i)
  })

  it('returns error when claim not found', async () => {
    const claimChain = buildChainable({ data: null, error: null })
    mockDb.from.mockReturnValue(claimChain)
    const r = await enqueueModule.enqueueFromFteExpenseClaim('missing')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not found/i)
  })

  it('returns error envelope (not throw) on db error', async () => {
    const claimChain = buildChainable({ data: null, error: { message: 'boom' } })
    mockDb.from.mockReturnValue(claimChain)
    const r = await enqueueModule.enqueueFromFteExpenseClaim('c1')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('boom')
  })
})

describe('enqueueFromContractorInvoice', () => {
  it('returns ok + queueId on success', async () => {
    const invChain = buildChainable({
      data: {
        id: 'inv1', location_id: 'loc1', status: 'approved',
        pdf_path: 'inv1.pdf', invoice_number: 'A001',
        period_start: '2026-05-01', period_end: '2026-05-31',
        invoice_amount: 100,
        contractor: { id: 'p1', full_name: 'Coach Sam', email: 'sam@x.com' },
      },
      error: null,
    })
    const queueChain = buildChainable({ data: { id: 'q1' }, error: null })
    mockDb.from.mockImplementation((t) => t === 'contractor_invoices' ? invChain : queueChain)
    const r = await enqueueModule.enqueueFromContractorInvoice('inv1')
    expect(r).toEqual({ ok: true, queueIds: ['q1'] })
  })

  it('refuses to enqueue when invoice has no PDF', async () => {
    const invChain = buildChainable({
      data: { id: 'inv1', location_id: 'loc1', status: 'approved', pdf_path: null },
      error: null,
    })
    mockDb.from.mockReturnValue(invChain)
    const r = await enqueueModule.enqueueFromContractorInvoice('inv1')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no PDF/i)
  })

  it('returns error when invoice not found', async () => {
    const invChain = buildChainable({ data: null, error: null })
    mockDb.from.mockReturnValue(invChain)
    const r = await enqueueModule.enqueueFromContractorInvoice('missing')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not found/i)
  })

  // CONTRACTOR-MIME.1 — this path hard-coded attachment_mime_type to
  // 'application/pdf' (its source column is named pdf_path, so the design
  // assumed PDF-only) while every OTHER enqueue path reads the real mime
  // from its source row. Contractors upload phone photos: a .png labelled
  // application/pdf was sent to Anthropic in a `document` block and 400'd
  // with "The PDF specified was not valid" (queue row ad57c308).
  function contractorRow(pdfPath) {
    return buildChainable({
      data: {
        id: 'inv1', location_id: 'loc1', status: 'approved',
        pdf_path: pdfPath, invoice_number: 'A001',
        period_start: '2026-05-01', period_end: '2026-05-31', invoice_amount: 100,
        contractor: { id: 'p1', full_name: 'Coach Sam', email: 'sam@x.com' },
      },
      error: null,
    })
  }

  it('reads the real mime + size from Storage rather than assuming PDF', async () => {
    const queueChain = buildChainable({ data: { id: 'q1' }, error: null })
    mockDb.from.mockImplementation((t) => t === 'contractor_invoices' ? contractorRow('p1/photo.png') : queueChain)
    mockDb.storage = {
      from: () => ({
        list: async () => ({
          data: [{ name: 'photo.png', metadata: { mimetype: 'image/png', size: 306832 } }],
          error: null,
        }),
      }),
    }
    const r = await enqueueModule.enqueueFromContractorInvoice('inv1')
    expect(r.ok).toBe(true)
    const inserted = queueChain.insert.mock.calls[0][0]
    expect(inserted.attachment_mime_type).toBe('image/png')
    expect(inserted.attachment_size_bytes).toBe(306832)
  })

  it('falls back to the file extension when Storage cannot be read', async () => {
    const queueChain = buildChainable({ data: { id: 'q1' }, error: null })
    mockDb.from.mockImplementation((t) => t === 'contractor_invoices' ? contractorRow('p1/photo.png') : queueChain)
    mockDb.storage = { from: () => ({ list: async () => { throw new Error('storage down') } }) }
    const r = await enqueueModule.enqueueFromContractorInvoice('inv1')
    expect(r.ok).toBe(true)
    const inserted = queueChain.insert.mock.calls[0][0]
    // The point of the ticket: NEVER application/pdf for a .png.
    expect(inserted.attachment_mime_type).toBe('image/png')
    expect(inserted.attachment_size_bytes).toBeNull()
  })

  it('still labels a real PDF as application/pdf', async () => {
    const queueChain = buildChainable({ data: { id: 'q1' }, error: null })
    mockDb.from.mockImplementation((t) => t === 'contractor_invoices' ? contractorRow('p1/invoice.pdf') : queueChain)
    delete mockDb.storage
    const r = await enqueueModule.enqueueFromContractorInvoice('inv1')
    expect(r.ok).toBe(true)
    expect(queueChain.insert.mock.calls[0][0].attachment_mime_type).toBe('application/pdf')
  })

  it('enqueues even when the mime cannot be determined at all', async () => {
    const queueChain = buildChainable({ data: { id: 'q1' }, error: null })
    mockDb.from.mockImplementation((t) => t === 'contractor_invoices' ? contractorRow('p1/scan') : queueChain)
    delete mockDb.storage
    const r = await enqueueModule.enqueueFromContractorInvoice('inv1')
    // A null mime surfaces later as a clear "Unsupported MIME type for OCR"
    // rather than a confusing Anthropic 400 — but the row must still exist.
    expect(r.ok).toBe(true)
    expect(queueChain.insert.mock.calls[0][0].attachment_mime_type).toBeNull()
  })
})

describe('enqueueFromHuntFind', () => {
  const validArgs = {
    locationId: 'loc1',
    huntId: 'hunt1',
    bucketPath: 'hunt1/receipt.pdf',
    filename: 'receipt.pdf',
    sizeBytes: 4321,
    mimeType: 'application/pdf',
    senderEmail: 'billing@supplier.com',
    subject: 'Invoice #445',
    contentHash: 'sha256:abc123',
  }

  it('returns deduped:true and does NOT insert when content_hash already exists', async () => {
    const dedupeChain = buildChainable({ data: { id: 'existing-q1', status: 'sent' }, error: null })
    mockDb.from.mockImplementation((t) => {
      if (t === 'invoices_queue') return dedupeChain
      throw new Error(`unexpected table ${t}`)
    })

    const r = await enqueueModule.enqueueFromHuntFind(validArgs)
    expect(r).toEqual({ ok: true, queueIds: ['existing-q1'], deduped: true })
    // Only the dedupe lookup should hit `from` — no separate insert call.
    expect(mockDb.from).toHaveBeenCalledTimes(1)
    expect(dedupeChain.insert).not.toHaveBeenCalled()
  })

  it('inserts a fresh row when content_hash is not already queued', async () => {
    const insertedRows = []
    const queueChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      insert: vi.fn((row) => {
        insertedRows.push(row)
        return queueChain
      }),
      single: vi.fn().mockResolvedValue({ data: { id: 'q-new' }, error: null }),
    }
    mockDb.from.mockImplementation((t) => {
      if (t === 'invoices_queue') return queueChain
      throw new Error(`unexpected table ${t}`)
    })

    const r = await enqueueModule.enqueueFromHuntFind(validArgs)
    expect(r).toEqual({ ok: true, queueIds: ['q-new'], deduped: false })
    expect(insertedRows).toHaveLength(1)
    const row = insertedRows[0]
    expect(row.source_type).toBe('email_hunt')
    expect(row.source_hunt_id).toBe('hunt1')
    expect(row.attachment_bucket).toBe('hunted-invoices')
    expect(row.status).toBe('received')
    expect(row.content_hash).toBe('sha256:abc123')
  })

  it('refuses without a db call when contentHash is missing', async () => {
    const r = await enqueueModule.enqueueFromHuntFind({ ...validArgs, contentHash: undefined })
    expect(r.ok).toBe(false)
    expect(mockDb.from).not.toHaveBeenCalled()
  })

  it('refuses without a db call when huntId is missing', async () => {
    const r = await enqueueModule.enqueueFromHuntFind({ ...validArgs, huntId: undefined })
    expect(r.ok).toBe(false)
    expect(mockDb.from).not.toHaveBeenCalled()
  })

  it('refuses without a db call when bucketPath is missing', async () => {
    const r = await enqueueModule.enqueueFromHuntFind({ ...validArgs, bucketPath: undefined })
    expect(r.ok).toBe(false)
    expect(mockDb.from).not.toHaveBeenCalled()
  })

  it('returns error envelope (not throw) when the hash lookup errors', async () => {
    const dedupeChain = buildChainable({ data: null, error: { message: 'connection reset' } })
    mockDb.from.mockImplementation((t) => {
      if (t === 'invoices_queue') return dedupeChain
      throw new Error(`unexpected table ${t}`)
    })

    const r = await enqueueModule.enqueueFromHuntFind(validArgs)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Hash lookup failed/)
  })
})

describe('enqueueFromCarDocument', () => {
  it('returns ok + queueId on success', async () => {
    const docChain = buildChainable({
      data: {
        id: 'd1', car_id: 'car1', storage_path: 'car1/d1.pdf', filename: 'invoice.pdf',
        mime_type: 'application/pdf', size_bytes: 12345,
        car: { id: 'car1', location_id: 'loc1', make: 'Tesla', model: 'Model 3', uk_reg: 'AB12 CDE' },
      },
      error: null,
    })
    const queueChain = buildChainable({ data: { id: 'q1' }, error: null })
    mockDb.from.mockImplementation((t) => t === 'car_documents' ? docChain : queueChain)
    const r = await enqueueModule.enqueueFromCarDocument('d1')
    expect(r).toEqual({ ok: true, queueIds: ['q1'] })
  })

  it('refuses when car has no location_id', async () => {
    const docChain = buildChainable({
      data: { id: 'd1', car_id: 'car1', storage_path: 'p.pdf', car: { id: 'car1', location_id: null } },
      error: null,
    })
    mockDb.from.mockReturnValue(docChain)
    const r = await enqueueModule.enqueueFromCarDocument('d1')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/location/i)
  })

  it('returns error when document not found', async () => {
    const docChain = buildChainable({ data: null, error: null })
    mockDb.from.mockReturnValue(docChain)
    const r = await enqueueModule.enqueueFromCarDocument('missing')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not found/i)
  })
})
