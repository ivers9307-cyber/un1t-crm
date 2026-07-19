// QSTASH.4 — response semantics of the QStash contact-imports worker route.
//
// Mirrors the postmark/webhook-replay workers' contract with QStash's
// retry machinery: 2xx = done (including "someone else already claimed
// it"), 5xx = the import ran and failed. `skipped` must 200 so a
// cron/worker race — or a QStash per-delivery timeout redelivering
// while the ORIGINAL invocation is still importing (status
// 'processing') — never causes a duplicate run.

import { describe, it, expect } from 'vitest'
import { responseForOutcome, statusForVerifyFailure, maxDuration } from './route'

describe('maxDuration', () => {
  it('gets the same 300s budget as the cron — imports legitimately run minutes', () => {
    expect(maxDuration).toBe(300)
  })
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

describe('responseForOutcome', () => {
  it('processed → 200 success', () => {
    expect(responseForOutcome({ status: 'processed' })).toEqual({
      status: 200,
      body: { success: true, processed: true },
    })
  })

  it('skipped → 200 so QStash does not redeliver a row another consumer owns', () => {
    expect(responseForOutcome({ status: 'skipped' })).toEqual({
      status: 200,
      body: { success: true, skipped: true },
    })
  })

  it('failed → 500 (row already stamped failed; the retry re-fetch will 200-skip)', () => {
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
