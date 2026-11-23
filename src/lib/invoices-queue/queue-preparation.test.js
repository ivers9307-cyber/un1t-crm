// queueInvoicePreparation: stamp rows for the analysis queue and publish
// one push per stamped row. The sweeper cron is the delivery guarantee, so
// nothing here may throw or fail a caller.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../tests/helpers/fake-db.js'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { queueInvoicePreparation } from './queue-preparation.js'
import { logError, logWarn } from '@/lib/log'
import {
  INVOICE_ANALYSIS_WORKER_PATH,
  INVOICE_ANALYSIS_QUEUE_NAME,
  INVOICE_ANALYSIS_QUEUE_PARALLELISM,
} from '@/lib/qstash'

const LOC = '00000000-0000-4000-8000-000000000001'
const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000a2'
const C = '00000000-0000-4000-8000-0000000000a3'

const row = (id, status, extra = {}) => ({
  id, location_id: LOC, status, attachment_bucket: 'invoices', attachment_path: null,
  analysis_queued_at: null, analysis_claimed_at: '2026-11-22T10:00:00.000Z', ...extra,
})

let publish
beforeEach(() => {
  vi.clearAllMocks()
  publish = vi.fn(async () => ({ ok: true }))
})

describe('queueInvoicePreparation', () => {
  it('stamps and publishes received and quality_approved rows (a row with no file included), skipping others', async () => {
    const db = createFakeDb({ tables: { invoices_queue: [row(A, 'received'), row(B, 'quality_approved', { attachment_path: 'x.pdf' }), row(C, 'extracted')] } })
    const result = await queueInvoicePreparation(db, [A, B, C], { publish })

    expect(result).toEqual({ queued: [A, B] })
    const byId = Object.fromEntries(db.tables.invoices_queue.map((r) => [r.id, r]))
    expect(byId[A].analysis_queued_at).toEqual(expect.any(String))
    expect(byId[A].analysis_claimed_at).toBe('2026-11-22T10:00:00.000Z')
    expect(byId[B].analysis_queued_at).toEqual(expect.any(String))
    expect(byId[C].analysis_queued_at).toBeNull()
    expect(byId[C].analysis_claimed_at).not.toBeNull()
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('keeps a fresh claim on a stamped row, and stamps a row with no claim', async () => {
    const fresh = new Date().toISOString()
    const db = createFakeDb({ tables: { invoices_queue: [row(A, 'received', { analysis_claimed_at: fresh }), row(B, 'received', { analysis_claimed_at: null })] } })
    const result = await queueInvoicePreparation(db, [A, B], { publish })
    expect(result).toEqual({ queued: [A, B] })
    const byId = Object.fromEntries(db.tables.invoices_queue.map((r) => [r.id, r]))
    expect(byId[A].analysis_claimed_at).toBe(fresh)
    expect(byId[A].analysis_queued_at).toEqual(expect.any(String))
    expect(byId[B].analysis_queued_at).toEqual(expect.any(String))
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('resolves { queued: [] } without throwing when the client itself throws', async () => {
    const db = { from() { throw new Error('client down') } }
    await expect(queueInvoicePreparation(db, [A], { publish })).resolves.toEqual({ queued: [] })
    expect(logError).toHaveBeenCalled()
  })

  it('publishes exactly as the bulk route does', async () => {
    const db = createFakeDb({ tables: { invoices_queue: [row(A, 'received')] } })
    await queueInvoicePreparation(db, [A], { publish })
    expect(publish).toHaveBeenCalledWith({
      path: INVOICE_ANALYSIS_WORKER_PATH,
      body: { id: A },
      deduplicationId: `invoice-analysis-${A}`,
      queueName: INVOICE_ANALYSIS_QUEUE_NAME,
      queueParallelism: INVOICE_ANALYSIS_QUEUE_PARALLELISM,
    })
    expect(INVOICE_ANALYSIS_QUEUE_PARALLELISM).toBe(2)
  })

  it('makes no query for empty or non-array ids', async () => {
    const db = createFakeDb({ tables: { invoices_queue: [] } })
    expect(await queueInvoicePreparation(db, [], { publish })).toEqual({ queued: [] })
    expect(await queueInvoicePreparation(db, undefined, { publish })).toEqual({ queued: [] })
    expect(await queueInvoicePreparation(db, 'abc', { publish })).toEqual({ queued: [] })
    expect(db.calls).toEqual([])
    expect(publish).not.toHaveBeenCalled()
  })

  it('a rejecting publish keeps the id queued, logs, and does not throw', async () => {
    const db = createFakeDb({ tables: { invoices_queue: [row(A, 'received')] } })
    publish = vi.fn(async () => { throw new Error('qstash down') })
    const result = await queueInvoicePreparation(db, [A], { publish })
    expect(result).toEqual({ queued: [A] })
    expect(logWarn).toHaveBeenCalled()
  })

  it('an update error returns nothing queued, logs, and publishes nothing', async () => {
    const db = createFakeDb({
      tables: { invoices_queue: [row(A, 'received')] },
      errors: { invoices_queue: { update: { message: 'boom' } } },
    })
    const result = await queueInvoicePreparation(db, [A], { publish })
    expect(result).toEqual({ queued: [] })
    expect(logError).toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
})
