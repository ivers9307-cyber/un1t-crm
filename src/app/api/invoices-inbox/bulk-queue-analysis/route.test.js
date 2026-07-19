// QSTASH.6 — the bulk-queue-analysis publish hook.
//
// "Send for analysis" is the ONLY site that marks invoices_queue rows
// for background analysis (sets analysis_queued_at — repo-sweep
// verified: bulk-analyse and the cron only ever CLEAR it). After the
// row updates land, each successfully-queued id is published to the
// QStash `invoice-analysis` QUEUE (parallelism 2 — bounded OCR
// concurrency; a 50-invoice bulk queue must NOT become 50 concurrent
// worker invocations). Publishes are fire-and-forget: env-gated inside
// publishQueuePush, dedup id DASH-ONLY (QStash 400s on colons — the
// QSTASH.2 lesson), batched with allSettled after the loop, own
// try/catch — a publish failure never changes the operator's response;
// the cron sweeps whatever QStash misses.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn() }))

vi.mock('../_bulk-helpers', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    loadBookkeeper: vi.fn(),
    loadAndScopeBulkRows: vi.fn(),
  }
})

vi.mock('@/lib/qstash', () => ({
  publishQueuePush: vi.fn().mockResolvedValue({ ok: true, messageId: 'msg-test' }),
  INVOICE_ANALYSIS_WORKER_PATH: '/api/webhooks/qstash/invoice-analysis',
  INVOICE_ANALYSIS_QUEUE_NAME: 'invoice-analysis',
  INVOICE_ANALYSIS_QUEUE_PARALLELISM: 2,
}))

import { POST } from './route.js'
import { loadBookkeeper, loadAndScopeBulkRows } from '../_bulk-helpers'
import {
  publishQueuePush,
  INVOICE_ANALYSIS_WORKER_PATH,
  INVOICE_ANALYSIS_QUEUE_NAME,
  INVOICE_ANALYSIS_QUEUE_PARALLELISM,
} from '@/lib/qstash'

// ─── fixtures ────────────────────────────────────────────────────────────────

const ID_1 = 'a0000000-0000-0000-0000-000000000001'
const ID_2 = 'a0000000-0000-0000-0000-000000000002'
const ID_3 = 'a0000000-0000-0000-0000-000000000003'
const USER = { id: 'u-1', role: 'master' }

function makeRequest(ids) {
  return new Request('http://localhost/api/invoices-inbox/bulk-queue-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
}

function makeRow(id, overrides = {}) {
  return { id, location_id: 'loc-1', status: 'quality_approved', attachment_path: 'x.pdf', ...overrides }
}

/** db mock for the row updates: update().eq().in() awaited as a thenable. */
function makeDb({ updateErrorForIds = new Set() } = {}) {
  const calls = { updates: [] }
  const db = {
    from: vi.fn(() => ({
      update: vi.fn((payload) => {
        const record = { payload, filters: [] }
        const builder = {
          eq: vi.fn((col, val) => {
            record.filters.push(['eq', col, val])
            return builder
          }),
          in: vi.fn((col, vals) => {
            record.filters.push(['in', col, vals])
            return builder
          }),
          then(resolve, reject) {
            calls.updates.push(record)
            const id = record.filters.find(([op, col]) => op === 'eq' && col === 'id')?.[2]
            const error = updateErrorForIds.has(id) ? { message: 'update refused' } : null
            return Promise.resolve({ data: null, error }).then(resolve, reject)
          },
        }
        return builder
      }),
    })),
  }
  return { db, _calls: calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  publishQueuePush.mockResolvedValue({ ok: true, messageId: 'msg-test' })
})

// ─── publish hook ────────────────────────────────────────────────────────────

describe('POST /api/invoices-inbox/bulk-queue-analysis — QStash publish hook', () => {
  it('publishes one enqueue message per successfully-queued row, onto the bounded-parallelism queue', async () => {
    const { db } = makeDb()
    loadBookkeeper.mockResolvedValue({ user: USER, db })
    loadAndScopeBulkRows.mockResolvedValue({
      rowsById: { [ID_1]: makeRow(ID_1), [ID_2]: makeRow(ID_2, { status: 'received' }) },
      missingIds: [],
      forbiddenIds: [],
    })

    const res = await POST(makeRequest([ID_1, ID_2]))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.data.counts).toEqual({ queued: 2 })
    expect(publishQueuePush).toHaveBeenCalledTimes(2)
    expect(publishQueuePush).toHaveBeenCalledWith({
      path: INVOICE_ANALYSIS_WORKER_PATH,
      body: { id: ID_1 },
      deduplicationId: `invoice-analysis-${ID_1}`, // DASH-ONLY — QStash 400s on colons
      queueName: INVOICE_ANALYSIS_QUEUE_NAME,
      queueParallelism: INVOICE_ANALYSIS_QUEUE_PARALLELISM,
    })
    expect(publishQueuePush).toHaveBeenCalledWith({
      path: INVOICE_ANALYSIS_WORKER_PATH,
      body: { id: ID_2 },
      deduplicationId: `invoice-analysis-${ID_2}`,
      queueName: INVOICE_ANALYSIS_QUEUE_NAME,
      queueParallelism: INVOICE_ANALYSIS_QUEUE_PARALLELISM,
    })
  })

  it('does not publish for skipped rows (wrong status / no attachment / missing / forbidden)', async () => {
    const { db } = makeDb()
    loadBookkeeper.mockResolvedValue({ user: USER, db })
    loadAndScopeBulkRows.mockResolvedValue({
      rowsById: {
        [ID_1]: makeRow(ID_1, { status: 'extracted' }),
        [ID_2]: makeRow(ID_2, { attachment_path: null }),
      },
      missingIds: [ID_3],
      forbiddenIds: [],
    })

    const res = await POST(makeRequest([ID_1, ID_2, ID_3]))
    const json = await res.json()

    expect(json.data.counts).toEqual({ skipped: 3 })
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('does not publish for a row whose queue update was refused', async () => {
    const { db } = makeDb({ updateErrorForIds: new Set([ID_1]) })
    loadBookkeeper.mockResolvedValue({ user: USER, db })
    loadAndScopeBulkRows.mockResolvedValue({
      rowsById: { [ID_1]: makeRow(ID_1), [ID_2]: makeRow(ID_2) },
      missingIds: [],
      forbiddenIds: [],
    })

    const res = await POST(makeRequest([ID_1, ID_2]))
    const json = await res.json()

    expect(json.data.counts).toEqual({ failed: 1, queued: 1 })
    expect(publishQueuePush).toHaveBeenCalledTimes(1)
    expect(publishQueuePush.mock.calls[0][0].body).toEqual({ id: ID_2 })
  })

  it('a rejected publish never fails the operator response (belt-and-braces — the cron sweeps)', async () => {
    const { db } = makeDb()
    loadBookkeeper.mockResolvedValue({ user: USER, db })
    loadAndScopeBulkRows.mockResolvedValue({
      rowsById: { [ID_1]: makeRow(ID_1) },
      missingIds: [],
      forbiddenIds: [],
    })
    publishQueuePush.mockRejectedValue(new Error('qstash exploded'))

    const res = await POST(makeRequest([ID_1]))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.counts).toEqual({ queued: 1 })
  })

  it('does not publish at all when nothing queued', async () => {
    const { db } = makeDb()
    loadBookkeeper.mockResolvedValue({ user: USER, db })
    loadAndScopeBulkRows.mockResolvedValue({ rowsById: {}, missingIds: [ID_1], forbiddenIds: [] })

    await POST(makeRequest([ID_1]))

    expect(publishQueuePush).not.toHaveBeenCalled()
  })
})
