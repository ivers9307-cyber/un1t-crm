// QSTASH.7 — behaviour contract for the shared class_booking_requests
// row processor. Claim/process/failure-bookkeeping semantics extracted
// from the process-class-bookings cron so the QStash worker route and
// the cron share ONE implementation and can run concurrently against
// the same table.
//
// Claim mechanism: flip status 'queued'→'processing' AND bump attempts
// in one conditional UPDATE, conditioned on status still being 'queued'
// — the same status CAS the cron has always used, keyed by id. Exactly
// one claimant matches; the loser matches 0 rows and skips.
//
// Failure split (unchanged from the cron):
//   processor RETURNS  → terminal; the decision tree stamped the row
//                        itself (booked / needs_review / failed) →
//                        'processed' whatever the outcome.
//   processor THROWS   → retryable; re-queue under MAX_ATTEMPTS, else
//                        flag needs_review — guarded on status still
//                        'processing' so a terminal stamp is never
//                        clobbered — and file the staff card
//                        (routeToReview 'processing_error') for the row
//                        the guard matched. The card's own behaviour
//                        (one card, reuse, fallback) runs against the
//                        real routeToReview in
//                        class-booking-retries-exhausted.test.js.
//
// Pure unit tests — no DB. Supabase client + processor are mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/class-booking-processor', () => ({
  processClassBookingRequest: vi.fn(),
  routeToReview: vi.fn(async () => ({ outcome: 'needs_review', detail: 'processing_error' })),
}))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { claimAndProcessBookingJob, MAX_ATTEMPTS } from './class-booking-queue.js'
import { processClassBookingRequest, routeToReview } from '@/lib/class-booking-processor'
import { logError, logWarn } from '@/lib/log'

// ── db mock factory ───────────────────────────────────────────────────────────

/**
 * Chainable Supabase mock for the two update shapes this lib issues:
 *   claim       — update({status:'processing',attempts}).eq('id').eq('status','queued')
 *                 .select('id').maybeSingle()
 *   bookkeeping — update({status:'queued'|'needs_review',last_error}).eq('id')
 *                 .eq('status','processing').select('id, approval_request_id')
 *                 ← awaited directly; resolves the rows the guard matched
 * Builders are thenables (the repo invariant), so the mock is too.
 * Records every update payload + filter chain for assertions.
 */
function makeDb({ claimData = { id: 'cbr-1' }, stampRejects = false, stampResult = { data: [{ id: 'cbr-1', approval_request_id: null }], error: null } } = {}) {
  const calls = { updates: [] }

  const fromMock = vi.fn(() => ({
    update: vi.fn((payload) => {
      const filters = []
      const record = { payload, filters }
      const builder = {
        eq: vi.fn((col, val) => {
          filters.push(['eq', col, val])
          return builder
        }),
        select: vi.fn((cols) => {
          record.selected = cols
          return {
            maybeSingle: () => {
              calls.updates.push(record)
              return Promise.resolve({ data: claimData })
            },
            // Bookkeeping awaits the .select() directly (an array).
            then(resolve, reject) {
              calls.updates.push(record)
              if (stampRejects) return Promise.reject(new Error('db down')).then(resolve, reject)
              return Promise.resolve(stampResult).then(resolve, reject)
            },
          }
        }),
      }
      return builder
    }),
  }))

  return { from: fromMock, _calls: calls }
}

const ROW = {
  id: 'cbr-1',
  location_id: 'loc-1',
  contact_id: 'ct-1',
  glofox_event_id: 'ev-1',
  status: 'queued',
  attempts: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── exports ───────────────────────────────────────────────────────────────────

describe('exports', () => {
  it('exports the attempt cap the cron + processor have always used', () => {
    expect(MAX_ATTEMPTS).toBe(3)
  })
})

// ── claimAndProcessBookingJob ─────────────────────────────────────────────────

describe('claimAndProcessBookingJob', () => {
  it('claims via CAS on id + queued status (bumping attempts), then runs the processor', async () => {
    const db = makeDb()
    processClassBookingRequest.mockResolvedValue({ outcome: 'booked' })

    const result = await claimAndProcessBookingJob(db, ROW)

    expect(result).toEqual({ status: 'processed', outcome: 'booked', detail: undefined })
    const claim = db._calls.updates[0]
    expect(claim.payload).toEqual({ status: 'processing', attempts: 1 })
    expect(claim.filters).toEqual([
      ['eq', 'id', 'cbr-1'],
      ['eq', 'status', 'queued'],
    ])
    expect(claim.selected).toBe('id')
    // The processor gets the row AS FETCHED (pre-claim attempts) — exactly
    // what the cron has always passed.
    expect(processClassBookingRequest).toHaveBeenCalledWith(db, ROW)
  })

  it('bumps attempts from the fetched row value', async () => {
    const db = makeDb()
    processClassBookingRequest.mockResolvedValue({ outcome: 'booked' })

    await claimAndProcessBookingJob(db, { ...ROW, attempts: 2 })

    expect(db._calls.updates[0].payload.attempts).toBe(3)
  })

  it('treats missing attempts as 0 (first claim = attempt 1)', async () => {
    const db = makeDb()
    processClassBookingRequest.mockResolvedValue({ outcome: 'booked' })

    await claimAndProcessBookingJob(db, { ...ROW, attempts: undefined })

    expect(db._calls.updates[0].payload.attempts).toBe(1)
  })

  it('returns skipped without running when another claimant won the CAS', async () => {
    const db = makeDb({ claimData: null })

    const result = await claimAndProcessBookingJob(db, ROW)

    expect(result).toEqual({ status: 'skipped' })
    expect(processClassBookingRequest).not.toHaveBeenCalled()
    expect(db._calls.updates).toHaveLength(1) // the losing claim only
  })

  it.each(['needs_review', 'failed'])(
    'a processor-returned %s outcome is PROCESSED (terminal — the decision tree stamped the row)',
    async (outcome) => {
      const db = makeDb()
      processClassBookingRequest.mockResolvedValue({ outcome, detail: 'prior_attendance' })

      const result = await claimAndProcessBookingJob(db, ROW)

      expect(result).toEqual({ status: 'processed', outcome, detail: 'prior_attendance' })
      // No bookkeeping write — the processor owns terminal stamps.
      expect(db._calls.updates).toHaveLength(1)
    },
  )

  it('re-queues under the attempt cap when the processor throws', async () => {
    const db = makeDb()
    processClassBookingRequest.mockRejectedValue(new Error('glofox 502'))

    const result = await claimAndProcessBookingJob(db, ROW) // attempts 0 → post-claim 1 < 3

    expect(result).toEqual({ status: 'failed', error: 'glofox 502', requeued: true })
    const stamp = db._calls.updates[1]
    expect(stamp.payload).toEqual({ status: 'queued', last_error: 'glofox 502' })
    // Guarded on status still 'processing' so a terminal stamp the
    // processor already wrote is never clobbered.
    expect(stamp.filters).toEqual([
      ['eq', 'id', 'cbr-1'],
      ['eq', 'status', 'processing'],
    ])
    // Under the cap there are retries left: no staff card yet.
    expect(routeToReview).not.toHaveBeenCalled()
  })

  it('flags needs_review at the attempt cap when the processor throws', async () => {
    const db = makeDb()
    processClassBookingRequest.mockRejectedValue(new Error('glofox 502'))

    const result = await claimAndProcessBookingJob(db, { ...ROW, attempts: 2 }) // post-claim 3 >= 3

    expect(result).toEqual({ status: 'failed', error: 'glofox 502', requeued: false })
    expect(db._calls.updates[1].payload).toEqual({
      status: 'needs_review',
      last_error: 'glofox 502',
    })
    // REGISTRYREAD.1a — a bare needs_review is on no screen: the row the
    // guard matched gets its staff card.
    expect(routeToReview).toHaveBeenCalledTimes(1)
    expect(routeToReview).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'cbr-1', approval_request_id: null }), 'processing_error')
    expect(logError).not.toHaveBeenCalled()
  })

  // CBPCREDITREAD.1 — a throw may name its own card reason (CreditReadError
  // carries reviewReason 'credit_check_failed'). Duck-typed: this lib never
  // imports the processor's class (this file mocks the whole module).
  it('at the cap, a throw carrying reviewReason files the card under THAT reason', async () => {
    const db = makeDb()
    processClassBookingRequest.mockRejectedValue(Object.assign(new Error('credit_check_failed'), { reviewReason: 'credit_check_failed' }))

    const result = await claimAndProcessBookingJob(db, { ...ROW, attempts: 2 })

    expect(result).toEqual({ status: 'failed', error: 'credit_check_failed', requeued: false })
    expect(db._calls.updates[1].payload).toEqual({ status: 'needs_review', last_error: 'credit_check_failed' })
    expect(routeToReview).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'cbr-1' }), 'credit_check_failed')
  })

  // CBPCREDITREAD.1 review — the throw may also carry the account the
  // processor had elected; the card must name it (routeToReview's 4th arg).
  it('at the cap, a throw carrying reviewOptions hands them to routeToReview', async () => {
    const db = makeDb()
    const reviewOptions = { personContactIds: ['ct-1', 'ct-sib'], executingContactId: 'ct-sib', electedMemberId: 'gm-sib' }
    processClassBookingRequest.mockRejectedValue(Object.assign(new Error('credit_check_failed'), { reviewReason: 'credit_check_failed', reviewOptions }))

    await claimAndProcessBookingJob(db, { ...ROW, attempts: 2 })

    expect(routeToReview).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'cbr-1' }), 'credit_check_failed', reviewOptions)
  })

  it('under the cap, a reviewReason throw is still just a retry (re-queued, no card)', async () => {
    const db = makeDb()
    processClassBookingRequest.mockRejectedValue(Object.assign(new Error('credit_check_failed'), { reviewReason: 'credit_check_failed' }))

    const result = await claimAndProcessBookingJob(db, ROW)

    expect(result).toEqual({ status: 'failed', error: 'credit_check_failed', requeued: true })
    expect(db._calls.updates[1].payload).toEqual({ status: 'queued', last_error: 'credit_check_failed' })
    expect(routeToReview).not.toHaveBeenCalled()
  })

  it('at the cap, passes the card the row ALREADY names so routeToReview reuses it', async () => {
    const db = makeDb({ stampResult: { data: [{ id: 'cbr-1', approval_request_id: 'amr-9' }], error: null } })
    processClassBookingRequest.mockRejectedValue(new Error('glofox 502'))

    await claimAndProcessBookingJob(db, { ...ROW, attempts: 2 })

    expect(routeToReview).toHaveBeenCalledWith(db, expect.objectContaining({ approval_request_id: 'amr-9' }), 'processing_error')
  })

  it('at the cap, files NO card when the guard matched no row (the processor stamped it terminal)', async () => {
    const db = makeDb({ stampResult: { data: [], error: null } })
    processClassBookingRequest.mockRejectedValue(new Error('glofox 502'))

    const result = await claimAndProcessBookingJob(db, { ...ROW, attempts: 2 })

    expect(result).toEqual({ status: 'failed', error: 'glofox 502', requeued: false })
    expect(routeToReview).not.toHaveBeenCalled()
  })

  it('at the cap, files NO card when the bookkeeping write fails (the row is still processing; the reaper owns it)', async () => {
    const db = makeDb({ stampResult: { data: null, error: { message: 'fetch failed' } } })
    processClassBookingRequest.mockRejectedValue(new Error('glofox 502'))

    const result = await claimAndProcessBookingJob(db, { ...ROW, attempts: 2 })

    expect(result).toEqual({ status: 'failed', error: 'glofox 502', requeued: false })
    expect(routeToReview).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('class-booking-queue', expect.stringContaining('bookkeeping failed'), expect.objectContaining({ requestId: 'cbr-1' }))
  })

  it('at the cap, logs an error when no card could be filed', async () => {
    const db = makeDb()
    processClassBookingRequest.mockRejectedValue(new Error('glofox 502'))
    routeToReview.mockResolvedValueOnce({ outcome: 'failed', detail: 'review_unavailable:processing_error' })

    await claimAndProcessBookingJob(db, { ...ROW, attempts: 2 })

    expect(logError).toHaveBeenCalledWith('class-booking-queue', 'retries exhausted and no staff card could be filed', expect.objectContaining({ requestId: 'cbr-1' }))
  })

  it('stringifies non-Error throws', async () => {
    const db = makeDb()
    processClassBookingRequest.mockRejectedValue('string blew up')

    const result = await claimAndProcessBookingJob(db, ROW)

    expect(result).toEqual({ status: 'failed', error: 'string blew up', requeued: true })
  })

  it('still reports the failure when the bookkeeping update itself rejects', async () => {
    const db = makeDb({ stampRejects: true })
    processClassBookingRequest.mockRejectedValue(new Error('glofox 502'))

    const result = await claimAndProcessBookingJob(db, ROW)

    expect(result).toEqual({ status: 'failed', error: 'glofox 502', requeued: true })
  })
})
