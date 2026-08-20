// QSTASH.1 — response semantics of the QStash postmark worker route.
//
// The interesting property is the status-code contract with QStash's
// retry machinery: 2xx = done (including "someone else already handled
// it"), 5xx = retry me. A failed row must 500 so QStash retries it;
// a skipped row must 200 so a cron/worker race doesn't cause QStash to
// redeliver a row the cron already won.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/qstash', async (importOriginal) => ({
  ...(await importOriginal()),
  publishQueuePush: vi.fn().mockResolvedValue({ ok: true, messageId: 'm1' }),
}))

import {
  responseForOutcome,
  statusForVerifyFailure,
  deferredRetryDedupId,
  scheduleDeferredRetry,
  DEFERRED_RETRY_DELAY_SECONDS,
} from './route'
import { publishQueuePush, POSTMARK_WORKER_PATH } from '@/lib/qstash'

beforeEach(() => {
  vi.clearAllMocks()
  publishQueuePush.mockResolvedValue({ ok: true, messageId: 'm1' })
})

describe('statusForVerifyFailure', () => {
  it('maps missing_keys to 503 (server misconfig, not caller failure)', () => {
    expect(statusForVerifyFailure('missing_keys')).toBe(503)
  })

  it.each(['missing_signature', 'malformed', 'bad_signature', 'expired', 'not_yet_valid', 'body_mismatch', 'url_mismatch'])(
    'maps %s to 401',
    (reason) => {
      expect(statusForVerifyFailure(reason)).toBe(401)
    },
  )
})

describe('responseForOutcome — deferred (POSTMARK-RACE.1)', () => {
  // The event is genuinely unprocessed, so 500 would be the honest code for a
  // generic failure — but not for THIS failure. QStash retries within seconds,
  // and the thing being waited on is an email_sends insert whose worst measured
  // commit lag on prod is 13.2s; QStash would spend the row's whole retry
  // budget inside a window it cannot outrun, and the budget is what bounds the
  // dead-letter. 200 retires the QStash message and hands recovery to the
  // 10-minute sweeper cron, which is the delivery guarantee this queue has
  // always had. The row itself is still pending with attempts+1 — nothing is
  // acknowledged as done.
  it('answers 200 so QStash retires the message and the sweeper takes over', () => {
    expect(responseForOutcome({ status: 'deferred', error: 'send_row_not_yet_committed', attempts: 1 })).toEqual({
      status: 200,
      body: { success: true, deferred: true },
    })
  })

  it('is distinct from skipped — a skip means someone else handled it', () => {
    expect(responseForOutcome({ status: 'deferred' }).body).not.toEqual(
      responseForOutcome({ status: 'skipped' }).body
    )
  })
})

// ── POSTMARK-RACE.2 — recovery is a delayed re-publish, not the sweeper ──
//
// Answering 200 retires the QStash message, and the original fix handed the
// row to the */10 sweeper cron on the strength of "10 minutes is ~45x the
// worst commit lag". That sized the WAIT against the commit window but not
// against the sweeper's THROUGHPUT: at 100 rows per tick it can drain 600
// rows/hour, and a prod campaign burst produces ~1,000 raced events in a
// single 10-minute window (peak measured 1,038). On 2026-08-10 the cron ran at
// exactly 100 per tick from 18:10 past 21:40 — hours behind, with one-click
// unsubscribes and hard bounces sharing the same FIFO. So the worker schedules
// its own retry instead, and the cron goes back to being the guarantee.
describe('scheduleDeferredRetry (POSTMARK-RACE.2)', () => {
  it('re-publishes the row to the worker with a delay past the worst commit lag', async () => {
    await scheduleDeferredRetry('row-1', 1)

    expect(publishQueuePush).toHaveBeenCalledWith({
      path: POSTMARK_WORKER_PATH,
      body: { id: 'row-1' },
      deduplicationId: 'postmark-queue-row-1-r1',
      delaySeconds: DEFERRED_RETRY_DELAY_SECONDS,
    })
    // 13.2s is the worst commit lag ever measured on prod (3,231 samples).
    expect(DEFERRED_RETRY_DELAY_SECONDS).toBeGreaterThan(13.2 * 3)
  })

  // The ingest publish uses `postmark-queue-<id>`. Reusing it would land inside
  // QStash's dedup window and be SWALLOWED — the retry would simply never be
  // delivered and the row would silently fall back to the sweeper, which is the
  // latency this exists to remove. Same trap the host-campaign self-chain hit.
  it('scopes the dedup id per attempt so QStash cannot swallow the retry', () => {
    expect(deferredRetryDedupId('row-1', 1)).not.toBe('postmark-queue-row-1')
    expect(deferredRetryDedupId('row-1', 1)).not.toBe(deferredRetryDedupId('row-1', 2))
  })

  it('uses dashes only — QStash 400s on a colon in the dedup header', () => {
    expect(deferredRetryDedupId('row-1', 3)).not.toMatch(/[:%\s]/)
  })

  it('never throws, so a QStash outage cannot fail the worker response', async () => {
    publishQueuePush.mockRejectedValue(new Error('qstash exploded'))
    await expect(scheduleDeferredRetry('row-1', 1)).resolves.toBeUndefined()
  })

  it('is a no-op the queue does not depend on when QStash is unset', async () => {
    publishQueuePush.mockResolvedValue({ ok: false, skipped: true })
    await expect(scheduleDeferredRetry('row-1', 1)).resolves.toBeUndefined()
  })
})

describe('responseForOutcome', () => {
  it('processed → 200 success', () => {
    expect(responseForOutcome({ status: 'processed' })).toEqual({
      status: 200,
      body: { success: true, processed: true },
    })
  })

  it('skipped → 200 so QStash does not redeliver a row the cron won', () => {
    expect(responseForOutcome({ status: 'skipped' })).toEqual({
      status: 200,
      body: { success: true, skipped: true },
    })
  })

  it('failed → 500 so QStash retries with backoff', () => {
    expect(responseForOutcome({ status: 'failed', error: 'kaboom' })).toEqual({
      status: 500,
      body: { success: false, error: 'kaboom' },
    })
  })

  it('failed with no error string → generic processing_failed', () => {
    expect(responseForOutcome({ status: 'failed' })).toEqual({
      status: 500,
      body: { success: false, error: 'processing_failed' },
    })
  })
})
