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
  resolveEmailSendLocation: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/log', () => ({
  logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn(),
}))

import {
  claimAndProcessQueueRow,
  reclaimStaleQueueClaims,
  MAX_ATTEMPTS,
  EXHAUSTED_PROVIDER,
  EXHAUSTED_ERROR_PREFIX,
  CLAIMED_ERROR_MARKER,
  STALE_QUEUE_CLAIM_MS,
} from './postmark-queue.js'
import { processPostmarkEvent } from '@/lib/postmark-webhook-processor'
import { deadLetterWebhook, resolveEmailSendLocation } from '@/lib/webhook-dead-letter'
import { logError } from '@/lib/log'
import { isReplayable } from '@/lib/webhook-replay'
import { SEND_ROW_NOT_YET_COMMITTED } from './postmark-send-marker.js'

// ── db mock factory ───────────────────────────────────────────────────────────

/**
 * Chainable Supabase mock for the three update shapes this lib uses:
 *   claim:      update({processed_at, error: marker}).eq('id').is('processed_at', null).select('id, attempts')
 *   release:    update({processed_at: null, attempts, error}).eq('id')   (awaited)
 *   completion: update({error: null}).eq('id')                          (awaited)
 *
 * `claimData` is what the claim CAS reads back — the authoritative attempts
 * count, which may differ from the caller's snapshot when the two consumers
 * race. `releaseErrors` is a queue of per-call release results (shifted), so a
 * test can fail the first release and let the retry succeed.
 */
function makeDb({ claimData = [{ id: 'row-1' }], releaseErrors = [], completionError = null } = {}) {
  const calls = { claims: [], releases: [], completions: [], claimSelects: [] }

  const fromMock = vi.fn(() => ({
    update: vi.fn((payload) => {
      if (payload.processed_at === null) {
        // release / retry bookkeeping
        return {
          eq: vi.fn((col, val) => {
            calls.releases.push({ payload, id: val })
            return Promise.resolve({ error: releaseErrors.shift() ?? null })
          }),
        }
      }
      if (!('processed_at' in payload)) {
        // completion stamp
        return {
          eq: vi.fn((col, val) => {
            calls.completions.push({ payload, id: val })
            return Promise.resolve({ error: completionError })
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

  it('stamps the send log row location onto the capture (DEADLETTER-LOC.1)', async () => {
    // Un-stamped rows are invisible to the per-location integration-health
    // count — the mail-loss class this dead-letter exists to surface.
    resolveEmailSendLocation.mockResolvedValueOnce('loc-hatch')
    const db = makeDb({ claimData: [{ id: 'row-1', attempts: 4 }] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'boom' })

    await claimAndProcessQueueRow(db, { id: 'row-1', payload: unsubPayload, attempts: 4 })

    expect(resolveEmailSendLocation).toHaveBeenCalledWith(db, 'm-unsub-1')
    expect(deadLetterWebhook.mock.calls[0][1].locationId).toBe('loc-hatch')
  })

  it('an unresolvable send leaves locationId null — the capture still lands', async () => {
    resolveEmailSendLocation.mockResolvedValueOnce(null)
    const db = makeDb({ claimData: [{ id: 'row-1', attempts: 4 }] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'boom' })

    await claimAndProcessQueueRow(db, { id: 'row-1', payload: { RecordType: 'Bounce' }, attempts: 4 })

    expect(deadLetterWebhook).toHaveBeenCalledTimes(1)
    expect(deadLetterWebhook.mock.calls[0][1].locationId).toBeNull()
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

// ── POSTMARK-QUEUE-RECLAIM.1 — the strand windows ─────────────────────────────
// Two ways a row used to get stuck LOOKING processed while its bounce /
// unsubscribe was never handled, invisible forever (Postmark already got its
// 200, both consumers skip non-NULL processed_at):
//   • the release UPDATE after a failed attempt errors — it was never
//     inspected, so the claim was simply never given back;
//   • the consumer dies mid-processing (platform kill) — nobody is alive to
//     release at all.
// Neither state was distinguishable from "successfully processed": the table
// has no completion column. The fix is code-only: the claim CAS stamps
// CLAIMED_ERROR_MARKER into `error`, success clears it, so `processed_at set +
// marker still there` = a claim whose owner died — reclaimable once it is
// older than any live attempt can be.

describe('claim marker + completion stamp', () => {
  const row = { id: 'row-1', payload: { RecordType: 'Bounce', MessageID: 'm1' }, attempts: 0 }

  it('stamps the claim with the in-flight marker', async () => {
    const db = makeDb()
    processPostmarkEvent.mockResolvedValue({ ok: true })

    await claimAndProcessQueueRow(db, row)

    expect(db._calls.claims[0].payload.error).toBe(CLAIMED_ERROR_MARKER)
  })

  it('clears the marker on success so the row reads as done', async () => {
    const db = makeDb()
    processPostmarkEvent.mockResolvedValue({ ok: true })

    const result = await claimAndProcessQueueRow(db, row)

    expect(result).toEqual({ status: 'processed' })
    expect(db._calls.completions).toHaveLength(1)
    expect(db._calls.completions[0]).toEqual({ payload: { error: null }, id: 'row-1' })
  })

  it('a failed completion stamp is logged loudly and does not fail the row', async () => {
    // The row now reads as in-flight and the stale sweep will re-process it —
    // re-processing is designed-in (the release path re-processes too), and it
    // beats inventing a failure for an event that WAS handled.
    const db = makeDb({ completionError: { message: 'update refused' } })
    processPostmarkEvent.mockResolvedValue({ ok: true })

    const result = await claimAndProcessQueueRow(db, row)

    expect(result).toEqual({ status: 'processed' })
    expect(logError).toHaveBeenCalledWith(
      'postmark-queue', expect.stringContaining('completion stamp failed'),
      expect.objectContaining({ id: 'row-1' })
    )
  })

  it('does not release a failed attempt without checking — a refused release is retried once', async () => {
    const db = makeDb({ releaseErrors: [{ message: 'connection reset' }, null] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'kaboom' })

    const result = await claimAndProcessQueueRow(db, row)

    expect(result.status).toBe('failed')
    expect(db._calls.releases).toHaveLength(2) // first refused, retry landed
    expect(db._calls.releases[1].payload).toEqual(db._calls.releases[0].payload)
  })

  it('a release that fails twice is logged loudly — the stale sweep is the recovery', async () => {
    const db = makeDb({ releaseErrors: [{ message: 'refused' }, { message: 'refused again' }] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'kaboom' })

    const result = await claimAndProcessQueueRow(db, row)

    // The original processing error still comes back — a release failure must
    // never mask it.
    expect(result.status).toBe('failed')
    expect(result.error).toBe('kaboom')
    expect(db._calls.releases).toHaveLength(2)
    expect(logError).toHaveBeenCalledWith(
      'postmark-queue', expect.stringContaining('RELEASE FAILED'),
      expect.objectContaining({ id: 'row-1' })
    )
  })
})

describe('reclaimStaleQueueClaims', () => {
  /**
   * Chainable mock for the sweep's two shapes:
   *   scan:    select(...).eq('error', marker).not(...).lt('processed_at', cutoff)
   *              .order(...).limit(n)            (awaited thenable)
   *   release: update({...}).eq('id').eq('error', marker).select('id')
   */
  function makeSweepDb({ staleRows = [], scanError = null, releaseData = null } = {}) {
    const calls = { scans: [], releases: [] }
    const db = {
      from: vi.fn(() => {
        const b = { _filters: [], _op: 'select' }
        const filter = (kind) => (...args) => { b._filters.push([kind, ...args]); return b }
        b.select = (cols) => {
          if (b._op === 'update') {
            calls.releases.push({ payload: b._payload, filters: b._filters })
            return Promise.resolve({
              data: releaseData ?? b._filters.filter(f => f[0] === 'eq' && f[1] === 'id').map(f => ({ id: f[2] })),
              error: null,
            })
          }
          b._cols = cols
          return b
        }
        b.update = (p) => { b._op = 'update'; b._payload = p; return b }
        b.eq = filter('eq')
        b.not = filter('not')
        b.lt = filter('lt')
        b.order = () => b
        b.limit = () => b
        b.then = (res, rej) => {
          calls.scans.push({ filters: b._filters })
          return Promise.resolve(scanError ? { data: null, error: scanError } : { data: staleRows, error: null }).then(res, rej)
        }
        return b
      }),
      _calls: calls,
    }
    return db
  }

  it('scans for the marker with a cutoff at least STALE_QUEUE_CLAIM_MS in the past', async () => {
    const db = makeSweepDb()
    const before = Date.now() - STALE_QUEUE_CLAIM_MS

    await reclaimStaleQueueClaims(db)

    const scan = db._calls.scans[0]
    expect(scan.filters).toContainEqual(['eq', 'error', CLAIMED_ERROR_MARKER])
    const lt = scan.filters.find(f => f[0] === 'lt' && f[1] === 'processed_at')
    expect(lt).toBeTruthy()
    expect(new Date(lt[2]).getTime()).toBeLessThanOrEqual(Date.now() - STALE_QUEUE_CLAIM_MS)
    expect(new Date(lt[2]).getTime()).toBeGreaterThanOrEqual(before - 5_000)
  })

  it('releases a stale claim with attempts+1 so the consumers retry it', async () => {
    const db = makeSweepDb({
      staleRows: [{ id: 'row-7', payload: { RecordType: 'Bounce' }, attempts: 1 }],
    })

    const summary = await reclaimStaleQueueClaims(db)

    expect(summary.reclaimed).toBe(1)
    expect(db._calls.releases).toHaveLength(1)
    const rel = db._calls.releases[0]
    expect(rel.payload.processed_at).toBeNull()
    expect(rel.payload.attempts).toBe(2)
    expect(rel.payload.error).not.toBe(CLAIMED_ERROR_MARKER)
    // Guarded: only a row still carrying the marker is released, so a racing
    // sweep (overlapping cron ticks) cannot double-release.
    expect(rel.filters).toContainEqual(['eq', 'id', 'row-7'])
    expect(rel.filters).toContainEqual(['eq', 'error', CLAIMED_ERROR_MARKER])
    expect(deadLetterWebhook).not.toHaveBeenCalled()
  })

  it('dead-letters the payload when the reclaim burns the last attempt', async () => {
    const payload = { RecordType: 'SubscriptionChange', Recipient: 'member@example.com' }
    const db = makeSweepDb({
      staleRows: [{ id: 'row-9', payload, attempts: MAX_ATTEMPTS - 1 }],
    })

    const summary = await reclaimStaleQueueClaims(db)

    expect(summary.reclaimed).toBe(1)
    expect(summary.deadLettered).toBe(1)
    expect(deadLetterWebhook).toHaveBeenCalledTimes(1)
    expect(deadLetterWebhook.mock.calls[0][1]).toMatchObject({
      provider: EXHAUSTED_PROVIDER,
      eventType: 'SubscriptionChange',
      payload,
    })
    expect(db._calls.releases[0].payload.error).toContain(EXHAUSTED_ERROR_PREFIX)
  })

  it('returns zeros and stays quiet when nothing is stale', async () => {
    const db = makeSweepDb()
    const summary = await reclaimStaleQueueClaims(db)
    expect(summary).toEqual({ reclaimed: 0, deadLettered: 0, failed: 0 })
    expect(db._calls.releases).toHaveLength(0)
  })

  it('a failing scan is logged and returns zeros — never throws into the cron', async () => {
    const db = makeSweepDb({ scanError: { message: 'scan refused' } })
    const summary = await reclaimStaleQueueClaims(db)
    expect(summary).toEqual({ reclaimed: 0, deadLettered: 0, failed: 0 })
    expect(logError).toHaveBeenCalled()
  })
})

// ── POSTMARK-RACE.1 — the bookkeeping bug that made the loss permanent ───────
//
// The processor used to answer "no email_sends row" with { ok: true }. That is
// what this layer reads as success: the claim STAYS stamped, the in-flight
// marker is cleared, and the row is `processed_at` non-NULL with the marker
// gone — indistinguishable from a genuinely handled event. Both consumers
// filter on `processed_at IS NULL`, the stale-claim sweep only reclaims rows
// that still carry the marker, and Postmark's own retry was already deduped at
// ingest by (RecordType + MessageID). So the delivery was gone for good.
//
// The contract these tests pin: an event that recorded NOTHING must leave the
// queue row pending, with attempts+1, so the sweeper re-runs it.
describe('claimAndProcessQueueRow — deferred: send row not committed yet', () => {
  const row = { id: 'row-race', payload: { RecordType: 'Delivery', MessageID: 'm-race' }, attempts: 0 }

  it('does NOT mark the event processed, and releases the claim with attempts+1', async () => {
    const db = makeDb()
    processPostmarkEvent.mockResolvedValue({ ok: false, error: SEND_ROW_NOT_YET_COMMITTED })

    const result = await claimAndProcessQueueRow(db, row)

    expect(result).toEqual({
      status: 'deferred', error: SEND_ROW_NOT_YET_COMMITTED, attempts: 1, deadLettered: false,
    })
    // The claim is given back — processed_at NULL is what makes the row
    // visible to the next sweeper tick and to the QStash worker's re-fetch.
    expect(db._calls.releases).toHaveLength(1)
    expect(db._calls.releases[0].payload.processed_at).toBeNull()
    expect(db._calls.releases[0].payload.attempts).toBe(1)
    // And crucially the completion stamp never ran: clearing the in-flight
    // marker is what says "done", and nothing was done.
    expect(db._calls.completions).toHaveLength(0)
    expect(deadLetterWebhook).not.toHaveBeenCalled()
  })

  it('is bounded — the attempt that spends the budget dead-letters and is NOT deferred', async () => {
    // Genuine noise can never get here (it is dropped in the processor without
    // the marker), but a marker on mail whose email_sends insert really failed
    // can. That must terminate, and terminate visibly: an infinite requeue is
    // the exact class this repo just removed from the Zoom sync.
    const db = makeDb({ claimData: [{ id: 'row-race', attempts: MAX_ATTEMPTS - 1 }] })
    processPostmarkEvent.mockResolvedValue({ ok: false, error: SEND_ROW_NOT_YET_COMMITTED })

    const result = await claimAndProcessQueueRow(db, row)

    expect(result.status).toBe('failed')
    expect(result.deadLettered).toBe(true)
    expect(result.attempts).toBe(MAX_ATTEMPTS)
    expect(deadLetterWebhook).toHaveBeenCalledWith(db, expect.objectContaining({
      provider: EXHAUSTED_PROVIDER,
      eventType: 'Delivery',
      payload: row.payload,
    }))
    expect(db._calls.releases[0].payload.error).toContain(EXHAUSTED_ERROR_PREFIX)
  })

  it('converges: the retry that finds the row processes normally', async () => {
    const db = makeDb({ claimData: [{ id: 'row-race', attempts: 1 }] })
    processPostmarkEvent.mockResolvedValue({ ok: true })

    const result = await claimAndProcessQueueRow(db, { ...row, attempts: 1 })

    expect(result).toEqual({ status: 'processed' })
    expect(db._calls.completions).toHaveLength(1)
    expect(db._calls.releases).toHaveLength(0)
  })

  it('an ordinary processing failure is still `failed`, not `deferred`', async () => {
    const db = makeDb()
    processPostmarkEvent.mockResolvedValue({ ok: false, error: 'boom' })

    const result = await claimAndProcessQueueRow(db, row)

    expect(result.status).toBe('failed')
  })
})
