// QSTASH.7 — response semantics of the QStash class-bookings worker route.
//
// Mirrors the other qstash workers' contract with QStash's retry
// machinery, with the failure split the class-booking cron has always
// had: a decision-tree RETURN (booked / needs_review / failed) is
// terminal — the processor stamped the row itself, a retry cannot
// improve it — so it 200s; a processor THROW re-queued the row under
// the attempt cap, so it 500s and QStash's redelivery re-runs it (the
// same later-tick retry the cron does, just sooner). `skipped` must 200
// so a cron/worker race — or a QStash per-delivery timeout redelivering
// while the ORIGINAL invocation is still processing — never causes a
// duplicate booking attempt.

import { describe, it, expect } from 'vitest'
import { responseForOutcome, statusForVerifyFailure, maxDuration } from './route'

describe('maxDuration', () => {
  it('gets the same 300s budget as the cron — the Glofox call chain can crawl', () => {
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
  it('processed (booked) → 200 success carrying the outcome', () => {
    expect(responseForOutcome({ status: 'processed', outcome: 'booked' })).toEqual({
      status: 200,
      body: { success: true, processed: true, outcome: 'booked' },
    })
  })

  it.each(['needs_review', 'failed'])(
    'processed (%s) → 200 — the decision tree stamped the row; a QStash retry cannot improve it',
    (outcome) => {
      expect(responseForOutcome({ status: 'processed', outcome })).toEqual({
        status: 200,
        body: { success: true, processed: true, outcome },
      })
    },
  )

  it('skipped → 200 so QStash does not redeliver a row another consumer owns', () => {
    expect(responseForOutcome({ status: 'skipped' })).toEqual({
      status: 200,
      body: { success: true, skipped: true },
    })
  })

  it('failed (processor threw) → 500 — the row was re-queued under the cap, the retry re-runs it', () => {
    expect(responseForOutcome({ status: 'failed', error: 'glofox 502', requeued: true })).toEqual({
      status: 500,
      body: { success: false, error: 'glofox 502' },
    })
  })

  it('failed at the attempt cap → still 500 (row now needs_review; the retry re-fetch will 200-skip)', () => {
    expect(responseForOutcome({ status: 'failed', error: 'glofox 502', requeued: false })).toEqual({
      status: 500,
      body: { success: false, error: 'glofox 502' },
    })
  })

  it('failed with no error string → generic processing_failed', () => {
    expect(responseForOutcome({ status: 'failed' })).toEqual({
      status: 500,
      body: { success: false, error: 'processing_failed' },
    })
  })
})
