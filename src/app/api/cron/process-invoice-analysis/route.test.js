// ROUTEWRAP.C5 — process-invoice-analysis on defineCron. The per-row work is
// src/lib/invoice-analysis-queue.test.js; here: the secret, the stamp on every
// tick that claimed, and a failed claim answering 500 with a fixed line (it
// used to answer the database's own message) and no stamp.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/invoice-analysis-queue', () => ({ processInvoiceAnalysisRow: vi.fn() }))
vi.mock('@/lib/invoices-queue/supplier-refresh', () => ({
  refreshStaleSupplierList: vi.fn(async () => ({ refreshed: null })),
  rematchUnmatchedSuppliers: vi.fn(async () => ({ checked: 0, matched: 0 })),
}))

const { GET } = await import('./route.js')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { processInvoiceAnalysisRow } = await import('@/lib/invoice-analysis-queue')
const { logError } = await import('@/lib/log')
const { refreshStaleSupplierList, rematchUnmatchedSuppliers } = await import('@/lib/invoices-queue/supplier-refresh')
const QUIET = { contacts_refreshed: 0, suppliers_checked: 0, suppliers_matched: 0 }

const req = (secret = 'shh') =>
  new Request('https://x.test/api/cron/process-invoice-analysis', { headers: { authorization: `Bearer ${secret}` } })
let batch
const seed = (extra = {}) => createFakeDb({ rpc: { claim_invoice_analysis_batch: () => batch }, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  batch = [{ id: 'inv-1' }, { id: 'inv-2' }]
  db = seed()
  processInvoiceAnalysisRow.mockImplementation(async (_db, row) => (row.id === 'inv-2' ? { status: 'processed', extractionError: 'unreadable' } : { status: 'processed' }))
})

describe('GET /api/cron/process-invoice-analysis', () => {
  it('401s without the secret, claiming nothing and stamping nothing', async () => {
    const res = await GET(req('wrong'))
    expect(res.status).toBe(401)
    expect(db.calls).toEqual([])
    expect(processInvoiceAnalysisRow).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a tick claims a batch, processes each row and stamps its own row only', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, claimed: 2, ok: 1, failed: 1, ...QUIET })
    expect(db.calls).toEqual([{ rpc: 'claim_invoice_analysis_batch', args: { p_limit: 10 } }])
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('process-invoice-analysis')
  })

  it('an empty queue is a clean tick and stamps', async () => {
    batch = []
    const res = await GET(req())
    expect(await res.json()).toEqual({ success: true, claimed: 0, ok: 0, failed: 0, ...QUIET })
    expect(stampHeartbeat).toHaveBeenCalledWith('process-invoice-analysis')
  })

  it('a failed claim is a failed run: 500, a fixed line, nothing processed or stamped', async () => {
    db = seed({ errors: { rpc: { claim_invoice_analysis_batch: { message: 'relation secret_i does not exist' } } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not claim the invoice batch' })
    expect(JSON.stringify(body)).not.toContain('secret_i')
    expect(processInvoiceAnalysisRow).not.toHaveBeenCalled()
    expect(refreshStaleSupplierList).not.toHaveBeenCalled()
    expect(rematchUnmatchedSuppliers).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('cron-process-invoice-analysis', expect.stringMatching(/failed/), expect.anything())
  })

  it('SUPPLIERMATCH.1: after the reads it refreshes a stale contact list and re-checks unmatched suppliers', async () => {
    refreshStaleSupplierList.mockResolvedValueOnce({ refreshed: 'loc-1' })
    rematchUnmatchedSuppliers.mockResolvedValueOnce({ checked: 7, matched: 3 })
    const res = await GET(req())
    expect(await res.json()).toEqual({ success: true, claimed: 2, ok: 1, failed: 1, contacts_refreshed: 1, suppliers_checked: 7, suppliers_matched: 3 })
    expect(refreshStaleSupplierList).toHaveBeenCalledWith(db)
    expect(rematchUnmatchedSuppliers).toHaveBeenCalledWith(db)
    expect(refreshStaleSupplierList.mock.invocationCallOrder[0]).toBeLessThan(rematchUnmatchedSuppliers.mock.invocationCallOrder[0])
  })
})
