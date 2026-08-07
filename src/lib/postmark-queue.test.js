// QSTASH.1 — behaviour contract for the shared postmark_webhook_queue
// row processor. This is the exact claim/process/release semantics the
// drain cron has always had, extracted so the QStash worker route and
// the cron share one implementation.
//
// POSTMARK-DLQ.1 — plus the exhaustion contract. Both consumers select
// `.lt('attempts', MAX_ATTEMPTS)`, so the attempt that takes a row TO
// MAX_ATTEMPTS makes it invisible to the entire system: never retried, never
// alerted, and Postmark already 200'd so it will never be re-sent. Those rows
// carry hard bounces, spam complaints and one-click unsubscribes — losing one
// silently means we keep emailing someone who asked us to stop. The capture
// must therefore happen exactly at the transition, exactly once, and must
// never mask the processing error that caused it.
//
// Pure unit tests — no DB. Supabase client + event processor are mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/postmark-webhook-processor', () => ({
  processPostmarkEvent: vi.fn(),
}))
vi.mock('@/lib/webhook-dead-letter', () => ({
  deadLetterWebhook: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/log', () => ({
  logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn(),
}))

import {
  claimAndProcessQueueRow,
  MAX_ATTEMPTS,
  EXHAUSTED_PROVIDER,
  EXHAUSTED_ERROR_PREFIX,
} from './postmark-queue.js'
import { processPostmarkEvent } from '@/lib/postmark-webhook-processor'
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'
import { logError } from '@/lib/log'
import { isReplayable } from '@/lib/webhook-replay'

// ── db mock factory ───────────────────────────────────────────────────────────

/**
 * Chainable Supabase mock for the two update shapes this lib uses:
 *   claim:    update({processed_at}).eq('id').is('processed_at', null).select('id, attempts')
 *   release:  update({processed_at: null, attempts, error}).eq('id')   (awaited)
 *
 * `claimData` is what the claim CAS reads back — the authoritative attempts
 * count, which may differ from the caller's snapshot when the two consumers
 * race.
 */
function makeDb({ claimData = [{ id: 'row-1' }] } = {}) {
  const calls = { claims: [], releases: [], claimSelects: [] }

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
            select: vi.fn((cols) => {
              calls.claims.push({ payload, id: val })
              calls.claimSelects.push(cols)
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
  deadLetterWebhook.mockResolvedValue(undefined)
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
    expect(deadLetterWebhook).not.toHaveBeenCalled()
  })

  it('returns skipped without processing when another claimant won the CAS', async () => {
    const db = makeDb({ claimData: [] })

    const result = await claimAndProcessQueueRow(db, row)

    expect(result).toEqual({ status: 'skipped' })
    expect(processPostmarkEvent).not.toHaveBeenCalled()
    expect(deadLetterWebhook).not.toHaveBeenCalled()
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

    expect(result).toEqual({ status: 'failed', error: 'kaboom', attempts: 3, deadLettered: false })
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

    expect(result).toEqual({ status: 'failed', error: 'unknown', attempts: 1, deadLettered: false })
    expect(db._calls.releases[0].payload.error).toBe('unknown')
    expect(db._calls.releases[0].payload.attempts).toBe(1)
  })
})

// ── POSTMARK-DLQ.1 — exhaustion capture ───────────────────────────────────────

describe('claimAndProcessQueueRow — exhaustion dead-letter', () => {
  const unsubPayload = {
    RecordType: 'SubscriptionChange',
    MessageID: 'm-unsub-1',
    SuppressSending: true,
    Recipient: 'member@example.com',
  }

  it('dead-letters the row on the attempt that reaches MAX_ATTEMPTS', async () => {
    const db = makeDb({ claimData: [{ id: 'row-1', attempts: MAX_ATTEMPTS - 1 }] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'db blip' })

    const result = await claimAndProcessQueueRow(db, {
      id: 'row-1', payload: unsubPayload, attempts: MAX_ATTEMPTS - 1,
    })

    expect(result).toEqual({
      status: 'failed', error: 'db blip', attempts: MAX_ATTEMPTS, deadLettered: true,
    })
    expect(deadLetterWebhook).toHaveBeenCalledTimes(1)
  })

  it('captures a payload that is enough to recover the event later', async () => {
    // webhook_events stores no payload and the queue row is about to become
    // unselectable — this dead-letter row is the ONLY surviving copy, so the
    // body must be verbatim (a straight re-insert into the queue re-drives it).
    const db = makeDb({ claimData: [{ id: 'row-9', attempts: 4 }] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'contacts update failed' })

    await claimAndProcessQueueRow(db, { id: 'row-9', payload: unsubPayload, attempts: 4 })

    const [dbArg, args] = deadLetterWebhook.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(args.payload).toEqual(unsubPayload)
    expect(args.eventType).toBe('SubscriptionChange')
    // Queue-row forensics ride in the error text, NOT wrapped around the body.
    expect(args.error).toContain('row-9')
    expect(args.error).toContain('5 attempts')
    expect(args.error).toContain('contacts update failed')
  })

  it('captures under a provider key that is NOT auto-replayable', async () => {
    // 'postmark' re-inserts into postmark_webhook_queue with attempts = 0 —
    // resetting the budget that just ran out (unbounded loop) — and marks the
    // dead-letter row `resolved` on the INSERT, when nothing was processed.
    expect(EXHAUSTED_PROVIDER).toBe('postmark_queue')
    expect(EXHAUSTED_PROVIDER).not.toBe('postmark')
    expect(isReplayable(EXHAUSTED_PROVIDER)).toBe(false)

    const db = makeDb({ claimData: [{ id: 'row-1', attempts: 4 }] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'boom' })
    await claimAndProcessQueueRow(db, { id: 'row-1', payload: unsubPayload, attempts: 4 })

    expect(deadLetterWebhook.mock.calls[0][1].provider).toBe(EXHAUSTED_PROVIDER)
  })

  it('marks the queue row so an exhausted row is distinguishable from mid-retry', async () => {
    const db = makeDb({ claimData: [{ id: 'row-1', attempts: 4 }] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'boom' })

    await claimAndProcessQueueRow(db, { id: 'row-1', payload: unsubPayload, attempts: 4 })

    // processed_at stays NULL — the event was NOT processed.
    expect(db._calls.releases[0].payload).toEqual({
      processed_at: null,
      attempts: 5,
      error: `${EXHAUSTED_ERROR_PREFIX}: boom`,
    })
  })

  it('does NOT dead-letter a row failing its first attempt, and leaves it selectable', async () => {
    const db = makeDb({ claimData: [{ id: 'row-1', attempts: 0 }] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'transient' })

    const result = await claimAndProcessQueueRow(db, {
      id: 'row-1', payload: unsubPayload, attempts: 0,
    })

    expect(deadLetterWebhook).not.toHaveBeenCalled()
    expect(result.deadLettered).toBe(false)
    // attempts 1 < MAX_ATTEMPTS, processed_at null → still matches both
    // consumers' `.is('processed_at', null).lt('attempts', MAX_ATTEMPTS)`.
    expect(db._calls.releases[0].payload.attempts).toBe(1)
    expect(db._calls.releases[0].payload.attempts).toBeLessThan(MAX_ATTEMPTS)
    expect(db._calls.releases[0].payload.error).toBe('transient')
    expect(db._calls.releases[0].payload.error).not.toContain(EXHAUSTED_ERROR_PREFIX)
  })

  it('does not dead-letter on any attempt before the last one', async () => {
    for (let prev = 0; prev < MAX_ATTEMPTS - 1; prev += 1) {
      vi.clearAllMocks()
      const db = makeDb({ claimData: [{ id: 'row-1', attempts: prev }] })
      processPostmarkEvent.mockResolvedValue({ ok: false, error: 'transient' })

      const result = await claimAndProcessQueueRow(db, {
        id: 'row-1', payload: unsubPayload, attempts: prev,
      })

      expect(result.deadLettered).toBe(false)
      expect(deadLetterWebhook).not.toHaveBeenCalled()
    }
  })

  it('does NOT dead-letter an already-exhausted row again on a later sweep', async () => {
    // Belt-and-braces: both consumers filter these out, so this should be
    // unreachable — but "capture once" is a property of this function, not of
    // every caller's WHERE clause.
    const db = makeDb({ claimData: [{ id: 'row-1', attempts: MAX_ATTEMPTS }] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'still broken' })

    const result = await claimAndProcessQueueRow(db, {
      id: 'row-1', payload: unsubPayload, attempts: MAX_ATTEMPTS,
    })

    expect(deadLetterWebhook).not.toHaveBeenCalled()
    expect(result).toEqual({
      status: 'failed', error: 'still broken', attempts: MAX_ATTEMPTS + 1, deadLettered: false,
    })
    expect(db._calls.releases[0].payload.error).toBe('still broken')
  })

  it('counts attempts from the CAS read-back, not the caller stale snapshot', async () => {
    // The cron batches rows, then the QStash worker fails one of them: the
    // cron's in-memory `attempts` is now behind. Deriving "next" from the
    // snapshot would dead-letter the same exhaustion twice (and undercount).
    const db = makeDb({ claimData: [{ id: 'row-1', attempts: 4 }] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'boom' })

    const result = await claimAndProcessQueueRow(db, {
      id: 'row-1', payload: unsubPayload, attempts: 0, // stale
    })

    expect(db._calls.claimSelects[0]).toBe('id, attempts')
    expect(result.attempts).toBe(5)
    expect(result.deadLettered).toBe(true)
    expect(deadLetterWebhook).toHaveBeenCalledTimes(1)
  })

  it('falls back to the row snapshot when the CAS read-back has no attempts', async () => {
    const db = makeDb({ claimData: [{ id: 'row-1' }] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'boom' })

    const result = await claimAndProcessQueueRow(db, {
      id: 'row-1', payload: unsubPayload, attempts: 4,
    })

    expect(result.attempts).toBe(5)
    expect(result.deadLettered).toBe(true)
  })

  it('does not let a failing dead-letter mask the original processing error', async () => {
    // deadLetterWebhook is contractually never-throwing; if that ever changes,
    // the attempt must still release cleanly with the ORIGINAL error.
    deadLetterWebhook.mockRejectedValueOnce(new Error('dead-letter table gone'))
    const db = makeDb({ claimData: [{ id: 'row-1', attempts: 4 }] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'original failure' })

    const result = await claimAndProcessQueueRow(db, {
      id: 'row-1', payload: unsubPayload, attempts: 4,
    })

    expect(result).toEqual({
      status: 'failed', error: 'original failure', attempts: 5, deadLettered: true,
    })
    expect(db._calls.releases).toHaveLength(1)
    expect(db._calls.releases[0].payload.error).toBe(`${EXHAUSTED_ERROR_PREFIX}: original failure`)
    expect(logError).toHaveBeenCalledWith(
      'postmark-queue', 'dead-letter capture failed',
      expect.objectContaining({ id: 'row-1' })
    )
  })

  it('dead-letters bounces and spam complaints too, tagged with their record type', async () => {
    for (const RecordType of ['Bounce', 'SpamComplaint']) {
      vi.clearAllMocks()
      deadLetterWebhook.mockResolvedValue(undefined)
      const db = makeDb({ claimData: [{ id: 'row-1', attempts: 4 }] })
      processPostmarkEvent.mockResolvedValue({ ok: false, error: 'boom' })

      await claimAndProcessQueueRow(db, {
        id: 'row-1', payload: { RecordType, MessageID: 'm1' }, attempts: 4,
      })

      expect(deadLetterWebhook.mock.calls[0][1].eventType).toBe(RecordType)
    }
  })

  it('falls back to unknown when the payload carries no RecordType', async () => {
    const db = makeDb({ claimData: [{ id: 'row-1', attempts: 4 }] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'boom' })

    await claimAndProcessQueueRow(db, { id: 'row-1', payload: {}, attempts: 4 })

    expect(deadLetterWebhook.mock.calls[0][1].eventType).toBe('unknown')
  })
})
