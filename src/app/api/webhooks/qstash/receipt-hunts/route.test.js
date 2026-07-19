// QSTASH.10 — response semantics of the QStash receipt-hunts worker
// route.
//
// Mirrors the previous workers' contract with QStash's retry machinery.
// The load-bearing choice: EVERY hunt outcome — found, not_found AND
// error — is a **200**, because huntLine never throws and its own
// bookkeeping is terminal either way: found/not_found flip the line's
// status, and an error routes through errorFinish, which records a
// terminal recon_hunts audit row and DE-QUEUES the line
// (hunt_queued_at cleared — the cron does exactly the same: it tallies
// `failed` and never retries; the line waits for next Friday's
// re-seed). A QStash retry would re-fetch, find nothing queued, and
// skip — returning 500 would only burn retry budget on IMAP/LLM work
// that already recorded its outcome. `skipped` must 200 so a
// cron/worker race never causes a duplicate hunt; 500 is reserved for
// infrastructure errors (row fetch failure) where a retry genuinely
// helps.
//
// The route must NEVER call maybeFinalizeWeekly — that stays CRON-ONLY
// (it sends the weekly report email and stamps ANOTHER cron's
// heartbeat, and its "no report sent yet" check is check-then-act, not
// race-proof). See the route header.

import { describe, it, expect } from 'vitest'
import { responseForOutcome, statusForVerifyFailure, maxDuration } from './route'

describe('maxDuration', () => {
  it('gets the same 300s budget as the cron — a hunt is IMAP round-trips + an LLM call per candidate', () => {
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
  it('hunted found → 200 success with the outcome', () => {
    expect(responseForOutcome({ status: 'hunted', outcome: 'found' })).toEqual({
      status: 200,
      body: { success: true, processed: true, outcome: 'found' },
    })
  })

  it('hunted not_found → 200 success with the outcome', () => {
    expect(responseForOutcome({ status: 'hunted', outcome: 'not_found' })).toEqual({
      status: 200,
      body: { success: true, processed: true, outcome: 'not_found' },
    })
  })

  it('hunted error → STILL 200 (errorFinish already de-queued the line; the cron never retries these either)', () => {
    expect(responseForOutcome({ status: 'hunted', outcome: 'error' })).toEqual({
      status: 200,
      body: { success: true, processed: true, outcome: 'error' },
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
