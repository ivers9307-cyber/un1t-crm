// QSTASH.3 — response semantics of the QStash webhook-replay worker route.
//
// Mirrors the postmark worker's contract with QStash's retry machinery:
// 2xx = done (including "someone else already handled it"), 5xx = retry
// me. A failed replay must 500 so QStash retries it with ITS backoff
// (which replaces the cron's exponential backoff for pushed rows); a
// skipped row must 200 so a cron/worker race doesn't cause QStash to
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
