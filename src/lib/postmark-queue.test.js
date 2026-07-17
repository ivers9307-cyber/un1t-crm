// QSTASH.1 — behaviour contract for the shared postmark_webhook_queue
// row processor. This is the exact claim/process/release semantics the
// drain cron has always had, extracted so the QStash worker route and
// the cron share one implementation.
//
// Pure unit tests — no DB. Supabase client + event processor are mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/postmark-webhook-processor', () => ({
  processPostmarkEvent: vi.fn(),
}))

import { claimAndProcessQueueRow, MAX_ATTEMPTS } from './postmark-queue.js'
import { processPostmarkEvent } from '@/lib/postmark-webhook-processor'

// ── db mock factory ───────────────────────────────────────────────────────────

/**
 * Chainable Supabase mock for the two update shapes this lib uses:
 *   claim:    update({processed_at}).eq('id').is('processed_at', null).select('id')
 *   release:  update({processed_at: null, attempts, error}).eq('id')   (awaited)
 */
function makeDb({ claimData = [{ id: 'row-1' }] } = {}) {
  const calls = { claims: [], releases: [] }

  const fromMock = vi.fn(() => ({
    update: vi.fn((payload) => {
      if (payload.processed_at === null) {
        // release / retry bookkeeping
        return {
          eq: vi.fn((col, val) => {
            calls.releases.push({ payload, id: val })
            return Promise.resolve({ error: null })
          }),
        }
      }
      // claim CAS
      return {
        eq: vi.fn((col, val) => ({
          is: vi.fn(() => ({
            select: vi.fn(() => {
              calls.claims.push({ payload, id: val })
              return Promise.resolve({ data: claimData })
            }),
          })),
        })),
      }
    }),
  }))

  return { from: fromMock, _calls: calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── claimAndProcessQueueRow ───────────────────────────────────────────────────

describe('claimAndProcessQueueRow', () => {
  const row = { id: 'row-1', payload: { RecordType: 'Delivery', MessageID: 'm1' }, attempts: 0 }

  it('exports the queue retry budget the cron has always used', () => {
    expect(MAX_ATTEMPTS).toBe(5)
  })

  it('claims the row before processing and returns processed on success', async () => {
    const db = makeDb()
    processPostmarkEvent.mockResolvedValue({ ok: true })

    const result = await claimAndProcessQueueRow(db, row)

    expect(result).toEqual({ status: 'processed' })
    expect(db._calls.claims).toHaveLength(1)
    expect(db._calls.claims[0].id).toBe('row-1')
    expect(typeof db._calls.claims[0].payload.processed_at).toBe('string')
    expect(processPostmarkEvent).toHaveBeenCalledWith(db, row.payload)
    expect(db._calls.releases).toHaveLength(0)
  })

  it('returns skipped without processing when another claimant won the CAS', async () => {
    const db = makeDb({ claimData: [] })

    const result = await claimAndProcessQueueRow(db, row)

    expect(result).toEqual({ status: 'skipped' })
    expect(processPostmarkEvent).not.toHaveBeenCalled()
  })

  it('returns skipped when the claim select resolves with null data', async () => {
    const db = makeDb({ claimData: null })

    const result = await claimAndProcessQueueRow(db, row)

    expect(result).toEqual({ status: 'skipped' })
    expect(processPostmarkEvent).not.toHaveBeenCalled()
  })

  it('releases the claim with attempts+1 and the error when processing fails', async () => {
    const db = makeDb()
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'kaboom' })

    const result = await claimAndProcessQueueRow(db, { ...row, attempts: 2 })

    expect(result).toEqual({ status: 'failed', error: 'kaboom' })
    expect(db._calls.releases).toHaveLength(1)
    expect(db._calls.releases[0]).toEqual({
      payload: { processed_at: null, attempts: 3, error: 'kaboom' },
      id: 'row-1',
    })
  })

  it('defaults a missing processor error to unknown', async () => {
    const db = makeDb()
    processPostmarkEvent.mockResolvedValue({ ok: false })

    const result = await claimAndProcessQueueRow(db, row)

    expect(result).toEqual({ status: 'failed', error: 'unknown' })
    expect(db._calls.releases[0].payload.error).toBe('unknown')
    expect(db._calls.releases[0].payload.attempts).toBe(1)
  })
})
