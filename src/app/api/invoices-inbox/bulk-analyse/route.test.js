// INVOICEPREP.3 — bulk "Extract selected" runs the same preparation as the
// queue: claim each row (the queue's own claim), then prepareInvoiceRow.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

const LOC = 'a1000000-0000-4000-8000-000000000001'
const ID = 'a0000000-0000-4000-8000-00000000000a'
const ID2 = 'a0000000-0000-4000-8000-00000000000b'
let db

vi.mock('../_bulk-helpers', async (orig) => ({
  ...(await orig()),
  loadBookkeeper: vi.fn(async () => ({ user: { id: 'bk' }, db })),
  loadAndScopeBulkRows: vi.fn(async ({ ids }) => ({
    rowsById: Object.fromEntries(db.tables.invoices_queue.filter((r) => ids.includes(r.id)).map((r) => [r.id, { ...r }])),
    missingIds: ids.filter((id) => !db.tables.invoices_queue.some((r) => r.id === id)),
    forbiddenIds: [],
  })),
}))
vi.mock('@/lib/log', async (orig) => ({ ...(await orig()), logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/invoices-queue/prepare', () => ({ prepareInvoiceRow: vi.fn() }))

const { POST } = await import('./route.js')
const { prepareInvoiceRow } = await import('@/lib/invoices-queue/prepare')
const { CLAIM_STALE_MINUTES } = await import('@/lib/invoice-analysis-queue')

const row = (extra = {}) => ({
  id: ID, location_id: LOC, status: 'quality_approved',
  attachment_bucket: 'b', attachment_path: 'p.pdf', attachment_mime_type: 'application/pdf',
  analysis_claimed_at: null, analysis_queued_at: null, review_reasons: [],
  ...extra,
})
const run = (ids = [ID]) => POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ ids }), headers: { 'content-type': 'application/json' } }))
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString()
const mine = () => db.tables.invoices_queue[0]

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { invoices_queue: [row()] } })
  prepareInvoiceRow.mockResolvedValue({ outcome: 'prepared', reasons: [] })
})

describe('POST /api/invoices-inbox/bulk-analyse', () => {
  it('claims the row, then prepares the claimed row without force', async () => {
    let atCall
    prepareInvoiceRow.mockImplementationOnce(async (_db, r, deps) => {
      atCall = { row: r, deps, stored: { ...mine() } }
      return { outcome: 'prepared', reasons: [] }
    })
    const body = await (await run()).json()
    expect(body).toMatchObject({ success: true, data: { results: [{ id: ID, outcome: 'ok' }], counts: { ok: 1 } } })
    expect(atCall.deps).toBeUndefined()
    expect(atCall.row).toMatchObject({ id: ID, status: 'quality_approved', attachment_path: 'p.pdf' })
    expect(atCall.stored.analysis_claimed_at).toBeTruthy()
    expect(atCall.stored.analysis_queued_at).toBeTruthy()
  })

  it('a received row is claimed and prepared too', async () => {
    mine().status = 'received'
    const body = await (await run()).json()
    expect(body.data.results[0]).toMatchObject({ outcome: 'ok' })
    expect(prepareInvoiceRow).toHaveBeenCalledTimes(1)
  })

  it('an extracted row is not read again in bulk', async () => {
    mine().status = 'extracted'
    const body = await (await run()).json()
    expect(body.data.results[0]).toMatchObject({ outcome: 'skipped', reason: 'wrong_status:extracted' })
    expect(prepareInvoiceRow).not.toHaveBeenCalled()
  })

  it('a fresh claim means the queue is reading it: skipped, never read', async () => {
    mine().analysis_claimed_at = minutesAgo(1)
    const body = await (await run()).json()
    expect(body.data.results[0]).toMatchObject({ outcome: 'skipped', reason: 'being_read' })
    expect(prepareInvoiceRow).not.toHaveBeenCalled()
  })

  it('a stale claim is taken over', async () => {
    mine().analysis_claimed_at = minutesAgo(CLAIM_STALE_MINUTES + 5)
    const body = await (await run()).json()
    expect(body.data.results[0].outcome).toBe('ok')
  })

  it('maps not_invoice and duplicate to skipped with a reason, unreadable to failed', async () => {
    db = createFakeDb({ tables: { invoices_queue: [row(), row({ id: ID2 })] } })
    prepareInvoiceRow
      .mockResolvedValueOnce({ outcome: 'not_invoice', reasons: [] })
      .mockResolvedValueOnce({ outcome: 'duplicate', reasons: ['duplicate_file'] })
    let body = await (await run([ID, ID2])).json()
    expect(body.data.results).toEqual([
      { id: ID, outcome: 'skipped', reason: 'not_invoice' },
      { id: ID2, outcome: 'skipped', reason: 'duplicate_file' },
    ])
    expect(body.data.counts).toEqual({ skipped: 2 })

    db = createFakeDb({ tables: { invoices_queue: [row()] } })
    prepareInvoiceRow.mockResolvedValueOnce({ outcome: 'unreadable', reasons: ['unreadable'] })
    body = await (await run()).json()
    expect(body.data.results[0]).toMatchObject({ id: ID, outcome: 'failed', error: 'unreadable' })
  })

  it('a skipped preparation is skipped', async () => {
    prepareInvoiceRow.mockResolvedValueOnce({ outcome: 'skipped', reasons: [] })
    const body = await (await run()).json()
    expect(body.data.results[0]).toMatchObject({ outcome: 'skipped', reason: 'concurrent_change' })
  })

  it('a throw keeps the claim (the sweeper retries it) and reports failed', async () => {
    prepareInvoiceRow.mockRejectedValueOnce(new Error('boom'))
    const body = await (await run()).json()
    expect(body.data.results[0]).toMatchObject({ outcome: 'failed' })
    expect(mine().analysis_claimed_at).toBeTruthy()
    expect(mine().analysis_queued_at).toBeTruthy()
  })

  it('a row without a file is skipped', async () => {
    mine().attachment_path = null
    const body = await (await run()).json()
    expect(body.data.results[0]).toMatchObject({ outcome: 'skipped', reason: 'no_attachment' })
    expect(prepareInvoiceRow).not.toHaveBeenCalled()
  })

  it('a failed claim write reports failed and never reads', async () => {
    db = createFakeDb({ tables: { invoices_queue: [row()] }, errors: { invoices_queue: { update: { message: 'down' } } } })
    const body = await (await run()).json()
    expect(body.data.results[0]).toMatchObject({ outcome: 'failed' })
    expect(prepareInvoiceRow).not.toHaveBeenCalled()
  })
})
