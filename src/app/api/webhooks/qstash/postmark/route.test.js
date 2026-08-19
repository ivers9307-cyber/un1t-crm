// QSTASH.1 — response semantics of the QStash postmark worker route.
//
// The interesting property is the status-code contract with QStash's
// retry machinery: 2xx = done (including "someone else already handled
// it"), 5xx = retry me. A failed row must 500 so QStash retries it;
// a skipped row must 200 so a cron/worker race doesn't cause QStash to
// redeliver a row the cron already won.

import { describe, it, expect } from 'vitest'
import { responseForOutcome, statusForVerifyFailure } from './route'

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
