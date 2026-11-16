// XEROBULK.1 — bulk analyse applies supplier memory, as the single-row
// /extract route does: a known supplier opens with its coding picked.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const ID = 'a0000000-0000-4000-8000-00000000000a'
let patches
const fakeDb = {
  storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => new ArrayBuffer(4) }, error: null }) }) },
  from: () => {
    const q = {}
    q.update = (p) => { patches.push(p); return q }
    q.eq = () => q
    q.in = () => q
    q.then = (res) => Promise.resolve({ data: null, error: null }).then(res)
    return q
  },
}
vi.mock('../_bulk-helpers', async (orig) => ({
  ...(await orig()),
  loadBookkeeper: vi.fn(async () => ({ user: { id: 'bk' }, db: fakeDb })),
  loadAndScopeBulkRows: vi.fn(async () => ({
    rowsById: { [ID]: { id: ID, location_id: 'loc1', status: 'quality_approved', attachment_bucket: 'b', attachment_path: 'p.pdf', attachment_mime_type: 'application/pdf' } },
    missingIds: [], forbiddenIds: [],
  })),
}))
vi.mock('@/lib/invoice-extraction', () => ({
  extractInvoiceFieldsFromBytes: vi.fn(async () => ({ ok: true, fields: { supplier_name: 'Acme', invoice_number: '1', invoice_date: '2026-11-01', subtotal: 10, tax_amount: 2.3, total: 12.3, category: 'guess' } })),
}))
vi.mock('@/lib/invoices-queue/supplier-defaults', () => ({ resolveExtractionDefaults: vi.fn() }))

const { POST } = await import('./route.js')
const { resolveExtractionDefaults } = await import('@/lib/invoices-queue/supplier-defaults')
const run = () => POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ ids: [ID] }), headers: { 'content-type': 'application/json' } }))

beforeEach(() => { patches = []; vi.clearAllMocks() })

describe('POST /api/invoices-inbox/bulk-analyse — supplier memory', () => {
  it('a known supplier gets its remembered contact, account and category', async () => {
    resolveExtractionDefaults.mockResolvedValue({ xero_contact_ref: { kind: 'existing', xero_contact_id: 'c1' }, xero_account_id: 'a1', category: 'Supplies' })
    await run()
    expect(resolveExtractionDefaults).toHaveBeenCalledWith(fakeDb, 'loc1', 'Acme')
    expect(patches[0].extracted_fields).toMatchObject({ supplier_name: 'Acme', xero_account_id: 'a1', category: 'Supplies' })
  })

  it('a memory failure never blocks the analysis', async () => {
    resolveExtractionDefaults.mockRejectedValue(new Error('down'))
    const { data } = await (await run()).json()
    expect(data.results[0].outcome).toBe('ok')
    expect(patches[0].extracted_fields.category).toBe('guess')
  })
})
