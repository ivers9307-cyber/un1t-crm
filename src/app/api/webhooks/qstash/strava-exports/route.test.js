// QSTASH.9 — response semantics of the QStash strava-exports worker route.
//
// The deliberate divergence from the postmark/class-bookings workers is
// the FAILURE contract: a job failure returns 200, not 500. The shared
// unit (processExportJob) has already run the cron's failure bookkeeping
// — re-queued with the queue's OWN backoff (next_attempt_at now+1m…6h)
// under the attempt cap, terminal 'failed' at it — and the claim here is
// NOT a compare-and-swap (processOneJob flips 'processing' blind), so a
// QStash retry landing after the backoff passes could race the cron into
// a duplicate upload AND burn Strava's 100-req/15-min budget. Retries
// belong to the cron's schedule; 500 is reserved for infrastructure
// errors (row fetch) where nothing was processed and a retry helps.

import { describe, it, expect } from 'vitest'
import { responseForOutcome, statusForVerifyFailure, maxDuration } from './route'
import {
  STRAVA_EXPORTS_WORKER_PATH,
  STRAVA_EXPORTS_QUEUE_NAME,
  STRAVA_EXPORTS_QUEUE_PARALLELISM,
} from '@/lib/qstash'

describe('qstash constants', () => {
  it('worker path matches this route location', () => {
    expect(STRAVA_EXPORTS_WORKER_PATH).toBe('/api/webhooks/qstash/strava-exports')
  })

  it('queue is bounded at parallelism 2 (Strava rate budget: 100 req/15 min)', () => {
    expect(STRAVA_EXPORTS_QUEUE_NAME).toBe('strava-exports')
    expect(STRAVA_EXPORTS_QUEUE_PARALLELISM).toBe(2)
  })

  it('queue name is dash-only — QStash 400s on colons', () => {
    expect(STRAVA_EXPORTS_QUEUE_NAME).not.toMatch(/:/)
  })
})

describe('maxDuration', () => {
  it('gets the same 60s budget as the run-strava-exports cron', () => {
    expect(maxDuration).toBe(60)
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
  it('succeeded → 200 processed', () => {
    expect(responseForOutcome({ status: 'succeeded' })).toEqual({
      status: 200,
      body: { success: true, processed: true },
    })
  })

  it('skipped → 200 so QStash does not redeliver a row another consumer owns (or a terminal skip)', () => {
    expect(responseForOutcome({ status: 'skipped' })).toEqual({
      status: 200,
      body: { success: true, skipped: true },
    })
  })

  it('failed → 200, NOT 500 — bookkeeping already re-queued it on the cron backoff schedule; a QStash retry would race a non-CAS claim and burn Strava rate budget', () => {
    expect(responseForOutcome({ status: 'failed', error: 'strava 401' })).toEqual({
      status: 200,
      body: { success: true, failed: true, error: 'strava 401' },
    })
  })

  it('failed with no error string → generic processing_failed', () => {
    expect(responseForOutcome({ status: 'failed' })).toEqual({
      status: 200,
      body: { success: true, failed: true, error: 'processing_failed' },
    })
  })
})
