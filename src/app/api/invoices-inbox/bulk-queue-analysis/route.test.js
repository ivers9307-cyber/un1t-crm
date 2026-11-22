// "Send for analysis" (bulk-queue-analysis).
//
// INVOICEPREP.3 — the route no longer publishes itself: after its own row
// updates (status, who vouched for quality, stale error cleared) it hands the
// queued ids to queueInvoicePreparation, the one publisher. A helper failure
// never changes the operator's response. A live claim is never freed, and a
// row counts as queued only when the update returned it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

let db
vi.mock('../_bulk-helpers', async (importOriginal) => ({
  ...(await importOriginal()),
  loadBookkeeper: vi.fn(async () => ({ user: USER, db })),
  loadAndScopeBulkRows: vi.fn(async ({ ids }) => ({
    rowsById: Object.fromEntries(db.tables.invoices_queue.filter((r) => ids.includes(r.id)).map((r) => [r.id, { ...r }])),
    missingIds: ids.filter((id) => !db.tables.invoices_queue.some((r) => r.id === id)),
    forbiddenIds: [],
  })),
}))
vi.mock('@/lib/invoices-queue/queue-preparation', () => ({
  queueInvoicePreparation: vi.fn().mockResolvedValue({ queued: [] }),
}))

const { POST } = await import('./route.js')
const { loadAndScopeBulkRows } = await import('../_bulk-helpers')
const { queueInvoicePreparation } = await import('@/lib/invoices-queue/queue-preparation')

const LOC = 'b1000000-0000-4000-8000-000000000001'
const ID_1 = 'a0000000-0000-4000-8000-000000000001'
const ID_2 = 'a0000000-0000-4000-8000-000000000002'
const ID_3 = 'a0000000-0000-4000-8000-000000000003'
const USER = { id: 'b2000000-0000-4000-8000-000000000001', role: 'master' }

const makeRequest = (ids) => new Request('http://localhost/api/invoices-inbox/bulk-queue-analysis', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ids }),
})
const makeRow = (id, overrides = {}) => ({
  id, location_id: LOC, status: 'quality_approved', attachment_bucket: 'b', attachment_path: 'x.pdf',
  source_type: 'supplier_email', analysis_queued_at: null, analysis_claimed_at: null, ...overrides,
})
const stored = (id) => db.tables.invoices_queue.find((r) => r.id === id)
const seed = (rows, extra = {}) => { db = createFakeDb({ tables: { invoices_queue: rows }, ...extra }) }

beforeEach(() => {
  vi.clearAllMocks()
  queueInvoicePreparation.mockResolvedValue({ queued: [] })
  seed([])
})

describe('POST /api/invoices-inbox/bulk-queue-analysis', () => {
  it('hands every queued id to the preparation helper once, with the route client', async () => {
    seed([makeRow(ID_1), makeRow(ID_2, { status: 'received' })])
    const res = await POST(makeRequest([ID_1, ID_2]))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.data.counts).toEqual({ queued: 2 })
    expect(queueInvoicePreparation).toHaveBeenCalledTimes(1)
    expect(queueInvoicePreparation).toHaveBeenCalledWith(db, [ID_1, ID_2])
    expect(stored(ID_2)).toMatchObject({ status: 'quality_approved', quality_reviewed_by: USER.id })
    expect(stored(ID_1).analysis_queued_at).toBeTruthy()
  })

  it('never frees a live claim', async () => {
    const claim = new Date().toISOString()
    seed([makeRow(ID_1, { analysis_claimed_at: claim })])
    await POST(makeRequest([ID_1]))
    expect(stored(ID_1).analysis_claimed_at).toBe(claim)
  })

  it('a row that moved on before the update is not reported queued', async () => {
    seed([makeRow(ID_1), makeRow(ID_2)])
    // The scoped read saw quality_approved; by the update it has been extracted.
    loadAndScopeBulkRows.mockImplementationOnce(async () => {
      const rowsById = { [ID_1]: { ...stored(ID_1) }, [ID_2]: { ...stored(ID_2) } }
      stored(ID_1).status = 'extracted'
      return { rowsById, missingIds: [], forbiddenIds: [] }
    })
    const json = await (await POST(makeRequest([ID_1, ID_2]))).json()
    expect(json.data.results).toContainEqual({ id: ID_1, outcome: 'skipped', reason: 'concurrent_change' })
    expect(json.data.counts).toEqual({ skipped: 1, queued: 1 })
    expect(queueInvoicePreparation).toHaveBeenCalledWith(db, [ID_2])
    expect(stored(ID_1).status).toBe('extracted')
  })

  it('does not publish for skipped rows (wrong status / no attachment / missing)', async () => {
    seed([makeRow(ID_1, { status: 'extracted' }), makeRow(ID_2, { attachment_path: null })])
    const json = await (await POST(makeRequest([ID_1, ID_2, ID_3]))).json()
    expect(json.data.counts).toEqual({ skipped: 3 })
    expect(queueInvoicePreparation).not.toHaveBeenCalled()
  })

  it('a refused update is failed and not published', async () => {
    seed([makeRow(ID_1)], { errors: { invoices_queue: { update: { message: 'update refused' } } } })
    const json = await (await POST(makeRequest([ID_1]))).json()
    expect(json.data.counts).toEqual({ failed: 1 })
    expect(queueInvoicePreparation).not.toHaveBeenCalled()
  })

  it('a helper that rejects never fails the operator response', async () => {
    seed([makeRow(ID_1)])
    queueInvoicePreparation.mockRejectedValue(new Error('helper exploded'))
    const res = await POST(makeRequest([ID_1]))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.counts).toEqual({ queued: 1 })
  })
})
