import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { createFakeDb } from '../../../tests/helpers/fake-db.js'
import { prepareInvoiceRow, recheckInvoiceRow, XERO_LOOKUP_TIMEOUT_MS, isTransientReadError, readAttemptOf, MAX_READ_ATTEMPTS } from './prepare.js'

vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn(), logError: vi.fn() }))
// The default Xero lookup must never run in a test: every test injects deps.xero.
vi.mock('@/lib/xero/client', () => ({ withFreshToken: vi.fn(async () => { throw new Error('no real Xero in tests') }) }))

const LOC = '11111111-1111-4111-8111-111111111111'
const CONTACT = 'c0000000-0000-4000-8000-000000000001'
const ACCOUNT = 'a0000000-0000-4000-8000-000000000001'
const NOW = new Date('2026-11-22T12:00:00.000Z')
const BYTES = Buffer.from('%PDF-1.4\nAcme invoice\n', 'latin1')
const HASH = createHash('sha256').update(BYTES).digest('hex')

const rate = (tax_type, effective_rate) => ({ location_id: LOC, tax_type, effective_rate, status: 'ACTIVE', can_apply_to_expenses: true })
const RATES = [rate('INPUT2', 23), rate('INPUT3', 13.5), rate('NONE', 0)]
const KNOWN = {
  xero_contacts: [{ location_id: LOC, xero_contact_id: CONTACT, name: 'Acme Supplies', email: 'accounts@example.com', status: 'ACTIVE', is_supplier: true }],
  xero_supplier_defaults: [{ location_id: LOC, xero_contact_id: CONTACT, supplier_name: 'Acme Supplies', default_xero_account_id: ACCOUNT, default_account_code: '400', default_category: null, default_tax_type: 'INPUT2' }],
}

const queueRow = (over = {}) => ({
  id: 'q2',
  location_id: LOC,
  status: 'received',
  source_type: 'supplier_email',
  attachment_bucket: 'invoices',
  attachment_path: 'inbound/q2.pdf',
  attachment_mime_type: 'application/pdf',
  content_hash: HASH,
  received_at: '2026-11-20T10:00:00.000Z',
  extracted_fields: null,
  review_reasons: [],
  not_invoice_reason: null,
  analysis_queued_at: '2026-11-20T10:00:01.000Z',
  analysis_claimed_at: '2026-11-20T10:00:02.000Z',
  ...over,
})
const read = (over = {}) => ({
  supplier_name: 'Acme Supplies',
  invoice_number: 'INV-100',
  invoice_date: '2026-11-01',
  currency: 'EUR',
  subtotal: 100,
  tax_amount: 23,
  total: 123,
  document_type: 'invoice',
  line_items: [],
  ...over,
})
const contactRef = { kind: 'existing', xero_contact_id: CONTACT, name: 'Acme Supplies' }

let db, files, extract, findBill
const setup = ({ rows = [queueRow()], tables = {}, rates = RATES } = {}) => {
  db = createFakeDb({ tables: { invoices_queue: rows, xero_tax_rates: rates, ...tables } })
  db.storage = {
    from: () => ({
      download: vi.fn(async (path) => (files.has(path)
        ? { data: new Blob([files.get(path)]), error: null }
        : { data: null, error: { message: 'Object not found' } })),
    }),
  }
}
const stored = (id) => db.tables.invoices_queue.find((r) => r.id === id)
const run = (id = 'q2', deps = {}) => prepareInvoiceRow(db, { ...stored(id) }, { extract, xero: { findBill }, now: () => NOW, ...deps })

beforeEach(() => {
  files = new Map([['inbound/q2.pdf', BYTES], ['inbound/q1.pdf', BYTES]])
  extract = vi.fn(async () => ({ ok: true, fields: read(), raw_response: '{}' }))
  findBill = vi.fn(async () => null)
  setup()
})

describe('prepareInvoiceRow', () => {
  it('a row with no file is not an invoice, and nothing is read', async () => {
    setup({ rows: [queueRow({ attachment_path: null })] })
    expect(await run()).toEqual({ outcome: 'not_invoice', reasons: [] })
    expect(stored('q2')).toMatchObject({ status: 'not_invoice', not_invoice_reason: 'no_attachment' })
    expect(extract).not.toHaveBeenCalled()
  })

  it('a row with no file keeps the reason it already had', async () => {
    setup({ rows: [queueRow({ attachment_path: null, not_invoice_reason: 'too_large' })] })
    await run()
    expect(stored('q2').not_invoice_reason).toBe('too_large')
  })

  it('a failed download is unreadable and the status is left alone', async () => {
    files.clear()
    expect(await run()).toEqual({ outcome: 'unreadable', reasons: ['unreadable'] })
    expect(stored('q2')).toMatchObject({ status: 'received', review_reasons: ['unreadable'], extracted_at: NOW.toISOString() })
    expect(stored('q2').extraction_error).toMatch(/Object not found/)
    expect(extract).not.toHaveBeenCalled()
  })

  it('a failed read is unreadable and the status is left alone', async () => {
    extract.mockResolvedValueOnce({ ok: false, error: 'model said no' })
    setup({ rows: [queueRow({ status: 'quality_approved' })] })
    expect(await run()).toEqual({ outcome: 'unreadable', reasons: ['unreadable'] })
    expect(stored('q2')).toMatchObject({ status: 'quality_approved', review_reasons: ['unreadable'], extraction_error: 'model said no' })
  })

  it('an unexpected throw inside the reader is unreadable, not a rejection', async () => {
    extract.mockRejectedValueOnce(new Error('socket hang up'))
    expect(await run()).toEqual({ outcome: 'unreadable', reasons: ['unreadable'] })
    expect(stored('q2')).toMatchObject({ status: 'received', review_reasons: ['unreadable'], extraction_error: 'socket hang up', analysis_queued_at: null, analysis_claimed_at: null })
  })

  it('the same file as an older row is a duplicate, unread; the older row is not flagged', async () => {
    setup({ rows: [queueRow({ id: 'q1', attachment_path: 'inbound/q1.pdf', received_at: '2026-11-19T10:00:00.000Z' }), queueRow()] })
    expect(await run('q2')).toEqual({ outcome: 'duplicate', reasons: ['duplicate_file'] })
    expect(stored('q2')).toMatchObject({ status: 'received', review_reasons: ['duplicate_file'], duplicate_of_id: 'q1' })
    expect(extract).not.toHaveBeenCalled()

    expect(await run('q1')).toMatchObject({ outcome: 'prepared' })
    expect(stored('q1').review_reasons).not.toContain('duplicate_file')
  })

  it('two copies received at the same moment flag exactly one of them', async () => {
    setup({ rows: [queueRow({ id: 'q1', attachment_path: 'inbound/q1.pdf' }), queueRow()] })
    const a = await run('q1')
    const b = await run('q2')
    expect([a.outcome, b.outcome].sort()).toEqual(['duplicate', 'prepared'])
    expect(b.outcome).toBe('duplicate') // the larger id is the copy
    expect(stored('q2').duplicate_of_id).toBe('q1')
  })

  it('a copy of a rejected or not-invoice row is not a duplicate', async () => {
    setup({ rows: [
      queueRow({ id: 'q0', status: 'rejected', received_at: '2026-11-18T10:00:00.000Z' }),
      queueRow({ id: 'q1', status: 'not_invoice', received_at: '2026-11-19T10:00:00.000Z' }),
      queueRow(),
    ] })
    expect((await run()).outcome).toBe('prepared')
  })

  it('force reads a flagged copy and does not raise duplicate_file', async () => {
    setup({ rows: [queueRow({ id: 'q1', received_at: '2026-11-19T10:00:00.000Z' }), queueRow()] })
    const r = await run('q2', { force: true })
    expect(r.outcome).toBe('prepared')
    expect(r.reasons).not.toContain('duplicate_file')
    expect(stored('q2').status).toBe('extracted')
    expect(extract).toHaveBeenCalledTimes(1)
  })

  it('a row with no content_hash gets one written', async () => {
    setup({ rows: [queueRow({ content_hash: null })] })
    await run()
    expect(stored('q2').content_hash).toBe(HASH)
  })

  it('a statement is not an invoice, and keeps what was read', async () => {
    extract.mockResolvedValueOnce({ ok: true, fields: read({ document_type: 'statement' }), raw_response: '{}' })
    expect(await run()).toEqual({ outcome: 'not_invoice', reasons: [] })
    expect(stored('q2')).toMatchObject({ status: 'not_invoice', not_invoice_reason: 'document_type: statement', review_reasons: [] })
    expect(stored('q2').extracted_fields.supplier_name).toBe('Acme Supplies')
  })

  it('"other" is not an invoice either', async () => {
    extract.mockResolvedValueOnce({ ok: true, fields: read({ document_type: 'other' }), raw_response: '{}' })
    expect((await run()).outcome).toBe('not_invoice')
    expect(stored('q2').not_invoice_reason).toBe('document_type: other')
  })

  it('a statement a person vouched for (quality_approved) is never set aside: it is prepared', async () => {
    setup({ tables: KNOWN, rows: [queueRow({ status: 'quality_approved' })] })
    extract.mockResolvedValueOnce({ ok: true, fields: read({ document_type: 'statement' }), raw_response: '{}' })
    expect(await run()).toEqual({ outcome: 'prepared', reasons: ['not_an_invoice'] })
    expect(stored('q2')).toMatchObject({ status: 'extracted', not_invoice_reason: null, review_reasons: ['not_an_invoice'] })
    expect(stored('q2').extracted_fields.document_type).toBe('statement')
  })

  it('"other" on a quality_approved row is prepared too', async () => {
    setup({ rows: [queueRow({ status: 'quality_approved' })] })
    extract.mockResolvedValueOnce({ ok: true, fields: read({ document_type: 'other' }), raw_response: '{}' })
    expect((await run()).outcome).toBe('prepared')
    expect(stored('q2').status).toBe('extracted')
    expect(stored('q2').review_reasons).toContain('not_an_invoice')
  })

  it('a credit note is prepared as an invoice with the credit_note reason', async () => {
    setup({ tables: KNOWN })
    extract.mockResolvedValueOnce({ ok: true, fields: read({ document_type: 'credit_note' }), raw_response: '{}' })
    expect(await run()).toEqual({ outcome: 'prepared', reasons: ['credit_note'] })
    expect(stored('q2').status).toBe('extracted')
  })

  it('a known supplier with a remembered account and a matched 23% rate is ready', async () => {
    setup({ tables: KNOWN })
    expect(await run()).toEqual({ outcome: 'prepared', reasons: [] })
    const row = stored('q2')
    expect(row).toMatchObject({ status: 'extracted', review_reasons: [], extraction_error: null, duplicate_of_id: null, extracted_at: NOW.toISOString() })
    expect(row.extracted_fields).toMatchObject({ xero_contact_ref: contactRef, xero_account_id: ACCOUNT, account_code: '400', tax_type: 'INPUT2', tax_type_source: 'derived' })
    expect(row.extraction_confidence).toBeTruthy()
  })

  it('a derived tax type always carries tax_type_source derived, and a read one is not trusted', async () => {
    setup({ tables: KNOWN })
    extract.mockResolvedValueOnce({ ok: true, fields: read({ subtotal: 100, tax_amount: 13.5, total: 113.5, tax_type: 'MADEUP' }), raw_response: '{}' })
    await run()
    expect(stored('q2').extracted_fields).toMatchObject({ tax_type: 'INPUT3', tax_type_source: 'derived' })
  })

  it('no rate match leaves tax_type unset and raises no_vat_rate', async () => {
    setup({ tables: KNOWN })
    extract.mockResolvedValueOnce({ ok: true, fields: read({ subtotal: 100, tax_amount: 9, total: 109, tax_type: 'MADEUP' }), raw_response: '{}' })
    const r = await run()
    expect(r.reasons).toEqual(['no_vat_rate'])
    expect(stored('q2').extracted_fields.tax_type).toBeUndefined()
    expect(stored('q2').extracted_fields.tax_type_source).toBeUndefined()
  })

  it('a till receipt with no breakdown from a known supplier still needs a VAT rate', async () => {
    setup({ tables: KNOWN })
    extract.mockResolvedValueOnce({ ok: true, fields: read({ document_type: 'receipt', subtotal: null, tax_amount: 2.3, total: 12.3 }), raw_response: '{}' })
    const r = await run()
    expect(stored('q2').extracted_fields).toMatchObject({ tax_type: 'INPUT2', tax_type_source: 'derived' })
    expect(r.reasons).toContain('no_vat_rate')
  })

  it('a zero-VAT bill from a supplier remembered at 23% raises vat_differs', async () => {
    setup({ tables: KNOWN })
    extract.mockResolvedValueOnce({ ok: true, fields: read({ subtotal: 100, tax_amount: 0, total: 100 }), raw_response: '{}' })
    expect((await run()).reasons).toEqual(['vat_differs'])
  })

  it('an unknown supplier is a new supplier', async () => {
    expect(await run()).toEqual({ outcome: 'prepared', reasons: ['new_supplier'] })
  })

  it('a studio with no tax rates and no contacts is prepared, nothing thrown', async () => {
    setup({ rates: [] })
    expect(await run()).toEqual({ outcome: 'prepared', reasons: ['new_supplier', 'no_vat_rate'] })
    expect(stored('q2').status).toBe('extracted')
  })

  it('a failed tax-rate load is treated as no rates', async () => {
    db = createFakeDb({ tables: { invoices_queue: [queueRow()], ...KNOWN }, errors: { xero_tax_rates: { select: { message: 'boom' } } } })
    db.storage = { from: () => ({ download: async () => ({ data: new Blob([BYTES]), error: null }) }) }
    const r = await run()
    expect(r.outcome).toBe('prepared')
    expect(r.reasons).toContain('no_vat_rate')
  })

  it('the same supplier and number as a forwarded row is a duplicate number', async () => {
    setup({ tables: KNOWN, rows: [
      queueRow({ id: 'q0', status: 'forwarded', content_hash: 'other', received_at: '2026-10-01T10:00:00.000Z', extracted_fields: read({ invoice_number: ' inv-100 ', xero_contact_ref: contactRef }) }),
      queueRow({ id: 'q1', status: 'data_approved', content_hash: 'other2', received_at: '2026-10-02T10:00:00.000Z', extracted_fields: read({ xero_contact_ref: contactRef }) }),
      queueRow({ id: 'q9', status: 'forwarded', content_hash: 'other3', received_at: '2026-10-03T10:00:00.000Z', extracted_fields: read({ xero_contact_ref: { ...contactRef, xero_contact_id: 'someone-else' } }) }),
      queueRow(),
    ] })
    expect(await run()).toEqual({ outcome: 'prepared', reasons: ['duplicate_number'] })
    expect(stored('q2').duplicate_of_id).toBe('q1')
  })

  it('a matching number from a different supplier, or a rejected row, is not a duplicate', async () => {
    setup({ tables: KNOWN, rows: [
      queueRow({ id: 'q0', status: 'rejected', content_hash: 'x', extracted_fields: read({ xero_contact_ref: contactRef }) }),
      queueRow({ id: 'q1', status: 'forwarded', content_hash: 'y', extracted_fields: read({ xero_contact_ref: { ...contactRef, xero_contact_id: 'someone-else' } }) }),
      queueRow(),
    ] })
    expect((await run()).reasons).toEqual([])
  })

  it('a bill already in Xero raises already_in_xero', async () => {
    setup({ tables: KNOWN })
    findBill.mockResolvedValueOnce({ InvoiceID: 'x1', InvoiceNumber: 'INV-100' })
    expect((await run()).reasons).toEqual(['already_in_xero'])
    expect(findBill).toHaveBeenCalledWith(LOC, 'INV-100')
  })

  it('a failed Xero lookup is logged and raises nothing', async () => {
    setup({ tables: KNOWN })
    findBill.mockRejectedValueOnce(new Error('No Xero connection'))
    expect(await run()).toEqual({ outcome: 'prepared', reasons: [] })
    expect(stored('q2').status).toBe('extracted')
    expect(findBill).toHaveBeenCalledTimes(1)
  })

  it('no invoice number means no Xero lookup', async () => {
    extract.mockResolvedValueOnce({ ok: true, fields: read({ invoice_number: null }), raw_response: '{}' })
    await run()
    expect(findBill).not.toHaveBeenCalled()
  })

  it('a row a person rejected while it was being read is skipped and untouched', async () => {
    extract.mockImplementationOnce(async () => {
      stored('q2').status = 'rejected'
      return { ok: true, fields: read(), raw_response: '{}' }
    })
    const before = { ...stored('q2'), status: 'rejected' }
    expect(await run()).toEqual({ outcome: 'skipped', reasons: [] })
    expect(stored('q2')).toEqual(before)
  })

  it('every write clears the queue columns and stamps prepared_at', async () => {
    const cases = [
      () => setup({ rows: [queueRow({ attachment_path: null })] }),
      () => { setup(); files.clear() },
      () => setup({ rows: [queueRow({ id: 'q1', received_at: '2026-11-19T10:00:00.000Z' }), queueRow()] }),
      () => { setup(); extract.mockResolvedValueOnce({ ok: true, fields: read({ document_type: 'statement' }), raw_response: '{}' }) },
      () => setup({ tables: KNOWN }),
    ]
    for (const arrange of cases) {
      arrange()
      await run()
      expect(stored('q2')).toMatchObject({ prepared_at: NOW.toISOString(), analysis_queued_at: null, analysis_claimed_at: null })
    }
  })

  it('a Xero lookup that never answers times out: logged, no reason, row still extracted', async () => {
    expect(XERO_LOOKUP_TIMEOUT_MS).toBe(10_000)
    setup({ tables: KNOWN })
    findBill.mockImplementationOnce(() => new Promise(() => {}))
    expect(await run('q2', { xeroTimeoutMs: 5 })).toEqual({ outcome: 'prepared', reasons: [] })
    expect(stored('q2').status).toBe('extracted')
  })

  it('a hanging lookup still keeps the row\'s other reasons', async () => {
    findBill.mockImplementationOnce(() => new Promise(() => {}))
    expect(await run('q2', { xeroTimeoutMs: 5 })).toEqual({ outcome: 'prepared', reasons: ['new_supplier'] })
  })

  it('an empty file is unreadable, never hashed and never read', async () => {
    files.set('inbound/q2.pdf', Buffer.alloc(0))
    setup({ rows: [queueRow({ id: 'q1', content_hash: createHash('sha256').update('').digest('hex'), received_at: '2026-11-19T10:00:00.000Z' }), queueRow({ content_hash: null })] })
    expect(await run()).toEqual({ outcome: 'unreadable', reasons: ['unreadable'] })
    expect(stored('q2')).toMatchObject({ status: 'received', review_reasons: ['unreadable'], extraction_error: 'download: empty file', content_hash: null, analysis_queued_at: null })
    expect(extract).not.toHaveBeenCalled()
  })

  it('a row rejected before the read is skipped: no paid read, row untouched', async () => {
    const row = { ...stored('q2') }
    stored('q2').status = 'rejected'
    const before = { ...stored('q2') }
    expect(await prepareInvoiceRow(db, row, { extract, xero: { findBill }, now: () => NOW })).toEqual({ outcome: 'skipped', reasons: [] })
    expect(extract).not.toHaveBeenCalled()
    expect(stored('q2')).toEqual(before)
  })

  it('a failed status re-check does not block preparation', async () => {
    db = createFakeDb({ tables: { invoices_queue: [queueRow()], xero_tax_rates: RATES }, errors: { invoices_queue: { select: { message: 'boom' } } } })
    db.storage = { from: () => ({ download: async () => ({ data: new Blob([BYTES]), error: null }) }) }
    expect((await run()).outcome).toBe('prepared')
    expect(extract).toHaveBeenCalledTimes(1)
    expect(stored('q2').status).toBe('extracted')
  })

  it('a failed final write leaves the row unreadable with the database message', async () => {
    // Only the final write (status: extracted) fails; the fallback write succeeds.
    const from = db.from.bind(db)
    db.from = (table) => {
      const builder = from(table)
      if (table !== 'invoices_queue') return builder
      const update = builder.update.bind(builder)
      builder.update = (payload, options) => {
        if (payload.status === 'extracted') db.errors.invoices_queue = { update: { message: 'deadlock detected' } }
        else delete db.errors.invoices_queue
        return update(payload, options)
      }
      return builder
    }
    expect(await run()).toEqual({ outcome: 'unreadable', reasons: ['unreadable'] })
    expect(stored('q2')).toMatchObject({ status: 'received', review_reasons: ['unreadable'], prepared_at: NOW.toISOString(), analysis_queued_at: null, analysis_claimed_at: null })
    expect(stored('q2').extraction_error).toMatch(/deadlock detected/)
  })

  it('a row at another studio never counts as a duplicate', async () => {
    setup({ rows: [queueRow({ id: 'q1', location_id: '22222222-2222-4222-8222-222222222222', received_at: '2026-11-19T10:00:00.000Z' }), queueRow()] })
    expect((await run()).outcome).toBe('prepared')
  })
})

describe('recheckInvoiceRow', () => {
  const extractedRow = (fields, over = {}) => queueRow({ status: 'extracted', extracted_fields: fields, ...over })

  it('setting the supplier and account on a new-supplier row clears the reason', async () => {
    const fields = read({ xero_contact_ref: contactRef, xero_account_id: ACCOUNT, tax_type: 'INPUT2', tax_type_source: 'derived' })
    setup({ tables: KNOWN, rows: [extractedRow(fields, { review_reasons: ['new_supplier'] })] })
    expect(await recheckInvoiceRow(db, { ...stored('q2') })).toMatchObject({ reasons: [] })
    expect(stored('q2').review_reasons).toEqual([])
  })

  it('keeps a manual tax type exactly as it is', async () => {
    const fields = read({ xero_contact_ref: contactRef, xero_account_id: ACCOUNT, tax_type: 'INPUT3', tax_type_source: 'manual' })
    setup({ tables: KNOWN, rows: [extractedRow(fields)] })
    await recheckInvoiceRow(db, { ...stored('q2') })
    expect(stored('q2').extracted_fields).toMatchObject({ tax_type: 'INPUT3', tax_type_source: 'manual' })
  })

  it('keeps a tax type with no source exactly as it is', async () => {
    const fields = read({ xero_contact_ref: contactRef, xero_account_id: ACCOUNT, tax_type: 'INPUT3' })
    setup({ tables: KNOWN, rows: [extractedRow(fields)] })
    await recheckInvoiceRow(db, { ...stored('q2') })
    expect(stored('q2').extracted_fields.tax_type).toBe('INPUT3')
    expect(stored('q2').extracted_fields.tax_type_source).toBeUndefined()
  })

  it('re-derives a derived tax type after the amounts change', async () => {
    const fields = read({ xero_contact_ref: contactRef, xero_account_id: ACCOUNT, subtotal: 100, tax_amount: 13.5, total: 113.5, tax_type: 'INPUT2', tax_type_source: 'derived' })
    setup({ tables: KNOWN, rows: [extractedRow(fields)] })
    expect(await recheckInvoiceRow(db, { ...stored('q2') })).toMatchObject({ reasons: [] })
    expect(stored('q2').extracted_fields).toMatchObject({ tax_type: 'INPUT3', tax_type_source: 'derived' })
  })

  it('removes a derived tax type that no longer matches the amounts, and asks for a rate', async () => {
    const fields = read({ xero_contact_ref: contactRef, xero_account_id: ACCOUNT, subtotal: 100, tax_amount: 9, total: 109, tax_type: 'INPUT2', tax_type_source: 'derived' })
    setup({ tables: KNOWN, rows: [extractedRow(fields)] })
    expect(await recheckInvoiceRow(db, { ...stored('q2') })).toMatchObject({ reasons: ['no_vat_rate'] })
    expect(stored('q2').extracted_fields.tax_type).toBeUndefined()
    expect(stored('q2').extracted_fields.tax_type_source).toBeUndefined()
    expect(stored('q2').review_reasons).toEqual(['no_vat_rate'])
  })

  it('carries over already_in_xero and duplicate_file without calling Xero', async () => {
    const fields = read({ xero_contact_ref: contactRef, xero_account_id: ACCOUNT, tax_type: 'INPUT2', tax_type_source: 'derived' })
    setup({ tables: KNOWN, rows: [extractedRow(fields, { review_reasons: ['duplicate_file', 'already_in_xero', 'new_supplier'] })] })
    expect(await recheckInvoiceRow(db, { ...stored('q2') })).toMatchObject({ reasons: ['duplicate_file', 'already_in_xero'] })
  })

  it('recomputes duplicate_number', async () => {
    const fields = read({ xero_contact_ref: contactRef, xero_account_id: ACCOUNT, tax_type: 'INPUT2', tax_type_source: 'derived' })
    setup({ tables: KNOWN, rows: [
      queueRow({ id: 'q0', status: 'forwarded', content_hash: 'z', extracted_fields: read({ xero_contact_ref: contactRef }) }),
      extractedRow(fields),
    ] })
    expect(await recheckInvoiceRow(db, { ...stored('q2') })).toMatchObject({ reasons: ['duplicate_number'] })
  })

  it('writes the duplicate it finds, and clears a stale one', async () => {
    const fields = read({ xero_contact_ref: contactRef, xero_account_id: ACCOUNT, tax_type: 'INPUT2', tax_type_source: 'derived' })
    setup({ tables: KNOWN, rows: [
      queueRow({ id: 'q0', status: 'forwarded', content_hash: 'z', extracted_fields: read({ xero_contact_ref: contactRef }) }),
      extractedRow(fields),
    ] })
    await recheckInvoiceRow(db, { ...stored('q2') })
    expect(stored('q2').duplicate_of_id).toBe('q0')

    setup({ tables: KNOWN, rows: [extractedRow({ ...fields, invoice_number: 'INV-200' }, { review_reasons: ['duplicate_number'], duplicate_of_id: 'q0' })] })
    expect(await recheckInvoiceRow(db, { ...stored('q2') })).toMatchObject({ reasons: [] })
    expect(stored('q2').duplicate_of_id).toBeNull()
  })

  it('returns the fields as stored after the recheck', async () => {
    const fields = read({ xero_contact_ref: contactRef, xero_account_id: ACCOUNT, subtotal: 100, tax_amount: 13.5, total: 113.5, tax_type: 'INPUT2', tax_type_source: 'derived' })
    setup({ tables: KNOWN, rows: [extractedRow(fields)] })
    const out = await recheckInvoiceRow(db, { ...stored('q2') })
    expect(out.fields).toMatchObject({ tax_type: 'INPUT3', tax_type_source: 'derived' })
  })

  it('leaves a row that is no longer extracted alone', async () => {
    setup({ tables: KNOWN, rows: [queueRow({ status: 'forwarded', extracted_fields: read(), review_reasons: ['new_supplier'] })] })
    const row = { ...stored('q2'), status: 'extracted' }
    await recheckInvoiceRow(db, row)
    expect(stored('q2').review_reasons).toEqual(['new_supplier'])
  })

  it('never throws: a failed write returns the existing reasons', async () => {
    db = createFakeDb({ tables: { invoices_queue: [extractedRow(read(), { review_reasons: ['no_account'] })], xero_tax_rates: RATES }, errors: { invoices_queue: { update: { message: 'boom' } } } })
    expect(await recheckInvoiceRow(db, { ...stored('q2') })).toMatchObject({ reasons: ['no_account'] })
    expect(await recheckInvoiceRow(db, /** @type {any} */ (null))).toMatchObject({ reasons: [] })
  })
})

describe('SUPPLIERMATCH.1 — the supplier of a bill found in Xero', () => {
  it('fills the supplier from the Xero bill when no rule matched one', async () => {
    extract = vi.fn(async () => ({ ok: true, fields: read({ supplier_name: 'Acme Supplies Holdings (Head Office)' }), raw_response: '{}' }))
    findBill = vi.fn(async () => ({ InvoiceID: 'x1', InvoiceNumber: 'INV-100', Contact: { ContactID: CONTACT, Name: 'Acme Supplies' } }))
    setup({ tables: KNOWN })
    const out = await run()
    expect(out.reasons).toEqual(['already_in_xero'])
    expect(stored('q2').extracted_fields.xero_contact_ref).toEqual({ kind: 'existing', xero_contact_id: CONTACT, name: 'Acme Supplies', email: 'accounts@example.com' })
    expect(stored('q2').extracted_fields.xero_account_id).toBe(ACCOUNT)
  })

  it('ignores the Xero bill\'s supplier when its name does not agree with the document (a shared invoice number)', async () => {
    extract = vi.fn(async () => ({ ok: true, fields: read({ supplier_name: 'Zenith Timber' }), raw_response: '{}' }))
    findBill = vi.fn(async () => ({ InvoiceID: 'x1', InvoiceNumber: 'INV-100', Contact: { ContactID: CONTACT, Name: 'Acme Supplies' } }))
    setup({ tables: KNOWN })
    expect((await run()).reasons).toEqual(['already_in_xero', 'new_supplier'])
    expect(stored('q2').extracted_fields.xero_contact_ref).toBeUndefined()
  })

  it('ignores a Xero bill supplier that is not an active contact of this studio', async () => {
    extract = vi.fn(async () => ({ ok: true, fields: read({ supplier_name: 'Acme Supplies Holdings (Head Office)' }), raw_response: '{}' }))
    findBill = vi.fn(async () => ({ InvoiceID: 'x1', InvoiceNumber: 'INV-100', Contact: { ContactID: 'not-in-the-list', Name: 'Acme Supplies' } }))
    setup({ tables: KNOWN })
    expect((await run()).reasons).toEqual(['already_in_xero', 'new_supplier'])
  })

  it('keeps a supplier the rules matched, whatever the Xero bill says', async () => {
    findBill = vi.fn(async () => ({ InvoiceID: 'x1', InvoiceNumber: 'INV-100', Contact: { ContactID: 'someone-else', Name: 'Other' } }))
    setup({ tables: KNOWN })
    await run()
    expect(stored('q2').extracted_fields.xero_contact_ref.xero_contact_id).toBe(CONTACT)
  })

  it('a Xero bill with no contact leaves the row a new supplier', async () => {
    extract = vi.fn(async () => ({ ok: true, fields: read({ supplier_name: 'Nobody Known' }), raw_response: '{}' }))
    findBill = vi.fn(async () => ({ InvoiceID: 'x1', InvoiceNumber: 'INV-100' }))
    setup({ tables: KNOWN })
    expect((await run()).reasons).toEqual(['already_in_xero', 'new_supplier'])
  })
})

describe('SUPPLIERMATCH.1 — recheck with rematchSupplier', () => {
  const extractedRow = (fields, over = {}) => queueRow({ status: 'extracted', extracted_fields: fields, ...over })
  const unmatched = () => extractedRow(read({ supplier_name: 'Acme Supplies Ltd.' }), { review_reasons: ['new_supplier'], prepared_at: '2026-11-20T10:00:00.000Z' })

  it('finds the supplier, fills the remembered account, clears the reason and re-stamps', async () => {
    setup({ tables: KNOWN, rows: [unmatched()] })
    const out = await recheckInvoiceRow(db, { ...stored('q2') }, { rematchSupplier: true })
    expect(out.reasons).not.toContain('new_supplier')
    expect(stored('q2').extracted_fields.xero_contact_ref.xero_contact_id).toBe(CONTACT)
    expect(stored('q2').extracted_fields.xero_account_id).toBe(ACCOUNT)
    expect(stored('q2').prepared_at).not.toBe('2026-11-20T10:00:00.000Z')
  })

  it('without the option a recheck never looks for a supplier or re-stamps', async () => {
    setup({ tables: KNOWN, rows: [unmatched()] })
    const out = await recheckInvoiceRow(db, { ...stored('q2') })
    expect(out.reasons).toContain('new_supplier')
    expect(stored('q2').extracted_fields.xero_contact_ref).toBeUndefined()
    expect(stored('q2').prepared_at).toBe('2026-11-20T10:00:00.000Z')
  })

  it('still unmatched: the reason stays and the row is re-stamped so it is not looked at again', async () => {
    setup({ tables: KNOWN, rows: [extractedRow(read({ supplier_name: 'Nobody Known' }), { review_reasons: ['new_supplier'], prepared_at: '2026-11-20T10:00:00.000Z' })] })
    const out = await recheckInvoiceRow(db, { ...stored('q2') }, { rematchSupplier: true })
    expect(out.reasons).toContain('new_supplier')
    expect(stored('q2').prepared_at).not.toBe('2026-11-20T10:00:00.000Z')
  })

  it('never replaces a supplier a person already picked', async () => {
    const picked = { kind: 'existing', xero_contact_id: 'picked-by-hand', name: 'Hand Picked' }
    setup({ tables: KNOWN, rows: [extractedRow(read({ supplier_name: 'Acme Supplies', xero_contact_ref: picked }), { review_reasons: [] })] })
    await recheckInvoiceRow(db, { ...stored('q2') }, { rematchSupplier: true })
    expect(stored('q2').extracted_fields.xero_contact_ref).toEqual(picked)
  })
})

describe('INVHARDEN.1 — a reader outage is not an unreadable file', () => {
  const outage = (error) => { extract = vi.fn(async () => ({ ok: false, error })) }

  it.each([
    'Anthropic API request timed out after 90 s',
    'Anthropic API request failed: fetch failed',
    'Anthropic API error (529): {"type":"overloaded_error"}',
    'Anthropic API error (429): rate limited',
    'Anthropic API error (503): unavailable',
  ])('treats "%s" as an outage', (m) => expect(isTransientReadError(m)).toBe(true))

  it.each([
    'Extracted JSON failed schema validation: total: Invalid input',
    'Failed to parse extracted JSON: Unexpected token',
    'Anthropic API error (400): invalid image',
    'ANTHROPIC_API_KEY is not configured.',
    '',
  ])('treats "%s" as a problem with the file or setup', (m) => expect(isTransientReadError(m)).toBe(false))

  it('first outage: the row stays queued and claimed, notes attempt 1, and is not flagged', async () => {
    outage('Anthropic API request timed out after 90 s')
    const out = await run()
    expect(out.outcome).toBe('skipped')
    const r = stored('q2')
    expect(r.status).toBe('received')
    expect(r.review_reasons).toEqual([])
    expect(r.analysis_queued_at).toBe('2026-11-20T10:00:01.000Z')
    expect(r.analysis_claimed_at).toBe('2026-11-20T10:00:02.000Z')
    expect(readAttemptOf(r.extraction_error)).toBe(1)
  })

  it('the last attempt marks it unreadable and takes it off the queue', async () => {
    outage('Anthropic API error (529): overloaded')
    setup({ rows: [queueRow({ extraction_error: `The reader was unavailable (attempt ${MAX_READ_ATTEMPTS - 1} of ${MAX_READ_ATTEMPTS}). It will be read again shortly. x` })] })
    const out = await run()
    expect(out.outcome).toBe('unreadable')
    expect(stored('q2').review_reasons).toEqual(['unreadable'])
    expect(stored('q2').analysis_queued_at).toBeNull()
  })

  it('a successful read after an outage clears the note', async () => {
    setup({ tables: KNOWN, rows: [queueRow({ extraction_error: 'The reader was unavailable (attempt 1 of 3). It will be read again shortly. x' })] })
    expect((await run()).outcome).toBe('prepared')
    expect(stored('q2').extraction_error).toBeNull()
  })

  it('a bad file is unreadable at once', async () => {
    outage('Extracted JSON failed schema validation: total: Invalid input')
    expect((await run()).outcome).toBe('unreadable')
  })

  it('with a person waiting (force) an outage is reported at once, not retried', async () => {
    outage('Anthropic API request timed out after 90 s')
    expect((await run('q2', { force: true })).outcome).toBe('unreadable')
  })
})

