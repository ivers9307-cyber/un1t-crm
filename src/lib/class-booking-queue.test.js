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
//                        clobbered.
//
// Pure unit tests — no DB. Supabase client + processor are mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/class-booking-processor', () => ({
  processClassBookingRequest: vi.fn(),
}))

import { claimAndProcessBookingJob, MAX_ATTEMPTS } from './class-booking-queue.js'
import { processClassBookingRequest } from '@/lib/class-booking-processor'

// ── db mock factory ───────────────────────────────────────────────────────────

/**
 * Chainable Supabase mock for the two update shapes this lib issues:
 *   claim       — update({status:'processing',attempts}).eq('id').eq('status','queued')
 *                 .select('id').maybeSingle()
 *   bookkeeping — update({status:'queued'|'needs_review',last_error}).eq('id')
 *                 .eq('status','processing')  ← awaited directly
 * Builders are thenables (the repo invariant), so the mock is too.
 * Records every update payload + filter chain for assertions.
 */
function makeDb({ claimData = { id: 'cbr-1' }, stampRejects = false } = {}) {
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
          }
        }),
        // Bookkeeping updates are awaited without a trailing .select().
        then(resolve, reject) {
          calls.updates.push(record)
          if (stampRejects) return Promise.reject(new Error('db down')).then(resolve, reject)
          return Promise.resolve({ data: null, error: null }).then(resolve, reject)
        },
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
