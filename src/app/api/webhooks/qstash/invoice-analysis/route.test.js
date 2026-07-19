// QSTASH.6 — response semantics of the QStash invoice-analysis worker
// route.
//
// Mirrors the previous workers' contract with QStash's retry machinery,
// with ONE deliberate difference: a deterministic OCR failure is a
// **200 processed** outcome, not a 500 — the row is already stamped with
// its extraction_error and DE-QUEUED (the INV-BULK.1 design), so a
// QStash retry would only re-fetch, find nothing queued, and skip.
// Returning 500 would make QStash hammer a rate-limited Claude Vision
// call that fails deterministically; the operator retries manually from
// the UI instead. `skipped` must 200 so a cron/worker race never causes
// a duplicate extraction; 500 is reserved for infrastructure errors
// (row fetch failure) where a retry genuinely helps.

import { describe, it, expect } from 'vitest'
import { responseForOutcome, statusForVerifyFailure, maxDuration } from './route'

describe('maxDuration', () => {
  it('gets the same 300s budget as the cron — a worst-case OCR is ~15s but downloads can crawl', () => {
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

  it('processed with a recorded extraction error → STILL 200 (row de-queued; QStash must not retry a deterministic OCR failure)', () => {
    expect(responseForOutcome({ status: 'processed', extractionError: 'unreadable scan' })).toEqual({
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

  it('failed → 500 (infrastructure error — a QStash retry genuinely helps)', () => {
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
