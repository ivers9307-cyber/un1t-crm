// RCOV.P1 — cross-week status machine test coverage.
//
// Two batch operations that run during the Friday pull, before hunts
// are (re-)seeded:
//   sweepSubmittedLines — a submitted line whose hunted document was
//     REJECTED by the bookkeeper must stop counting as "in review":
//     flip it to needs_attention (terminal for automation; the
//     operator resolves). The healing side (queue row FORWARDED) is a
//     no-op — the Xero-side vanish covers it via syncBankLines instead.
//   seedHunts — queue every uncovered/not_found line for the drain
//     cron (idempotent: only rows not already queued get hunt_queued_at),
//     then (QSTASH.10) fire-and-forget publish a QStash push per seeded
//     row onto the `receipt-hunts` queue (parallelism 1 — hunts must
//     stay sequential), capped at HUNT_PUBLISH_CAP so a pathological
//     backlog seed can't blow the QStash free-tier daily request
//     budget; overflow rows drain via the cron sweep exactly as before.
//
// Mock style matches coverage.test.js: a chainable mock whose FINAL
// method resolves; intermediate steps return `this`.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// No @/lib/supabase mock needed: statuses.js takes `db` as a parameter.
// Its only import is @/lib/qstash (QSTASH.10's publish hook), mocked here.
vi.mock('@/lib/qstash', () => ({
  publishQueuePush: vi.fn().mockResolvedValue({ ok: true, messageId: 'msg-1' }),
  RECEIPT_HUNTS_WORKER_PATH: '/api/webhooks/qstash/receipt-hunts',
  RECEIPT_HUNTS_QUEUE_NAME: 'receipt-hunts',
  RECEIPT_HUNTS_QUEUE_PARALLELISM: 1,
}))

const mockDb = { from: vi.fn() }

let statuses
let qstash

// Chain whose FINAL method resolves; intermediate steps return this.
function chainable(finalValue, terminal) {
  const chain = {}
  for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'update', 'upsert', 'range', 'not', 'is']) {
    chain[m] = vi.fn().mockReturnThis()
  }
  chain[terminal] = vi.fn().mockResolvedValue(finalValue)
  return chain
}

beforeEach(async () => {
  vi.resetModules()
  mockDb.from.mockReset()
  statuses = await import('./statuses')
  qstash = await import('@/lib/qstash')
  qstash.publishQueuePush.mockClear()
  qstash.publishQueuePush.mockResolvedValue({ ok: true, messageId: 'msg-1' })
})

describe('sweepSubmittedLines', () => {
  it('flags the line whose queue row was rejected; leaves the forwarded one untouched', async () => {
    const submitted = chainable({
      data: [
        { id: 'line-rejected', invoices_queue_id: 'q-rejected' },
        { id: 'line-forwarded', invoices_queue_id: 'q-forwarded' },
      ],
      error: null,
    }, 'range')
    const queueLookup = chainable({
      data: [
        { id: 'q-rejected', status: 'rejected' },
        { id: 'q-forwarded', status: 'forwarded' },
      ],
      error: null,
    }, 'in')
    const flagUpdate = chainable({ data: null, error: null }, 'in')
    mockDb.from
      .mockReturnValueOnce(submitted)   // 1. select submitted lines w/ queue link
      .mockReturnValueOnce(queueLookup) // 2. queue row statuses
      .mockReturnValueOnce(flagUpdate)  // 3. flip rejected-backed lines

    const result = await statuses.sweepSubmittedLines(mockDb, 'loc-1')

    expect(result).toEqual({ swept: 2, flagged: 1 })
    expect(flagUpdate.update).toHaveBeenCalledTimes(1)
    expect(flagUpdate.update.mock.calls[0][0]).toMatchObject({ status: 'needs_attention' })
    expect(flagUpdate.in).toHaveBeenCalledWith('id', ['line-rejected'])
  })

  it('returns {swept:0, flagged:0} and makes only one from() call when there are no submitted lines', async () => {
    const submitted = chainable({ data: [], error: null }, 'range')
    mockDb.from.mockReturnValueOnce(submitted)

    const result = await statuses.sweepSubmittedLines(mockDb, 'loc-1')

    expect(result).toEqual({ swept: 0, flagged: 0 })
    expect(mockDb.from).toHaveBeenCalledTimes(1)
  })

  it('chunks the queue-status lookup .in() at 300 ids (301 ids → 2 lookups)', async () => {
    const submitted = chainable({
      data: Array.from({ length: 301 }, (_, i) => (
        { id: `line-${i}`, invoices_queue_id: `q-${i}` }
      )),
      error: null,
    }, 'range')
    const queueLookup = chainable({ data: [], error: null }, 'in')
    mockDb.from
      .mockReturnValueOnce(submitted)
      .mockReturnValue(queueLookup) // both chunk lookups reuse this chain

    const result = await statuses.sweepSubmittedLines(mockDb, 'loc-1')

    expect(result).toEqual({ swept: 301, flagged: 0 })
    expect(queueLookup.in).toHaveBeenCalledTimes(2)
    expect(queueLookup.in.mock.calls[0][1]).toHaveLength(300)
    expect(queueLookup.in.mock.calls[1][1]).toHaveLength(1)
  })
})

describe('seedHunts', () => {
  it('queues uncovered/not_found lines not already queued, scoped to the location', async () => {
    const seedUpdate = chainable({
      data: [{ id: 'line-1' }, { id: 'line-2' }, { id: 'line-3' }],
      error: null,
    }, 'select')
    mockDb.from.mockReturnValueOnce(seedUpdate)

    const result = await statuses.seedHunts(mockDb, 'loc-1')

    expect(result).toEqual({ seeded: 3 })
    expect(seedUpdate.update.mock.calls[0][0]).toMatchObject({ hunt_queued_at: expect.any(String) })
    expect(seedUpdate.eq).toHaveBeenCalledWith('location_id', 'loc-1')
    expect(seedUpdate.in).toHaveBeenCalledWith('status', ['uncovered', 'not_found'])
    expect(seedUpdate.is).toHaveBeenCalledWith('hunt_queued_at', null)
  })

  // ── QSTASH.10 publish hook ──────────────────────────────────────────────────

  it('publishes one QStash push per seeded row onto the receipt-hunts queue (parallelism 1, dash-only dedup id)', async () => {
    const seedUpdate = chainable({
      data: [{ id: 'line-1' }, { id: 'line-2' }],
      error: null,
    }, 'select')
    mockDb.from.mockReturnValueOnce(seedUpdate)

    const result = await statuses.seedHunts(mockDb, 'loc-1')

    expect(result).toEqual({ seeded: 2 })
    expect(qstash.publishQueuePush).toHaveBeenCalledTimes(2)
    expect(qstash.publishQueuePush).toHaveBeenCalledWith({
      path: '/api/webhooks/qstash/receipt-hunts',
      body: { id: 'line-1' },
      deduplicationId: 'receipt-hunt-line-1',
      queueName: 'receipt-hunts',
      queueParallelism: 1,
    })
    expect(qstash.publishQueuePush).toHaveBeenCalledWith({
      path: '/api/webhooks/qstash/receipt-hunts',
      body: { id: 'line-2' },
      deduplicationId: 'receipt-hunt-line-2',
      queueName: 'receipt-hunts',
      queueParallelism: 1,
    })
  })

  it('publishes nothing when the seed queued zero rows', async () => {
    const seedUpdate = chainable({ data: [], error: null }, 'select')
    mockDb.from.mockReturnValueOnce(seedUpdate)

    const result = await statuses.seedHunts(mockDb, 'loc-1')

    expect(result).toEqual({ seeded: 0 })
    expect(qstash.publishQueuePush).not.toHaveBeenCalled()
  })

  it('caps publishes at HUNT_PUBLISH_CAP; overflow rows are left to the cron sweep', async () => {
    const ids = Array.from({ length: statuses.HUNT_PUBLISH_CAP + 1 }, (_, i) => ({ id: `line-${i}` }))
    const seedUpdate = chainable({ data: ids, error: null }, 'select')
    mockDb.from.mockReturnValueOnce(seedUpdate)

    const result = await statuses.seedHunts(mockDb, 'loc-1')

    expect(result).toEqual({ seeded: statuses.HUNT_PUBLISH_CAP + 1 })
    expect(qstash.publishQueuePush).toHaveBeenCalledTimes(statuses.HUNT_PUBLISH_CAP)
    // First HUNT_PUBLISH_CAP ids in order — the overflow row is the one skipped.
    const publishedIds = qstash.publishQueuePush.mock.calls.map((c) => c[0].body.id)
    expect(publishedIds[0]).toBe('line-0')
    expect(publishedIds).toHaveLength(statuses.HUNT_PUBLISH_CAP)
    expect(publishedIds).not.toContain(`line-${statuses.HUNT_PUBLISH_CAP}`)
  })

  it('exports HUNT_PUBLISH_CAP = 200 (QStash free tier caps 1000 requests/day; a Friday seed must stay well inside it)', () => {
    expect(statuses.HUNT_PUBLISH_CAP).toBe(200)
  })

  it('still returns the seed result when every publish rejects (belt-and-braces — a publish problem must never affect seeding)', async () => {
    const seedUpdate = chainable({
      data: [{ id: 'line-1' }],
      error: null,
    }, 'select')
    mockDb.from.mockReturnValueOnce(seedUpdate)
    qstash.publishQueuePush.mockRejectedValue(new Error('qstash down'))

    const result = await statuses.seedHunts(mockDb, 'loc-1')

    expect(result).toEqual({ seeded: 1 })
  })
})
