// CRONREADERR.1 — the class-booking drain. A failed queue read is not "queue
// empty": 500, nothing claimed, no stamp. The reaper's two writes RESOLVE with
// { error } (a builder never throws), so the old try/catch never saw them:
// both are now attempted, then judged; a failure is logged, counted
// (reap_failed) and withholds the stamp, while the queue still runs.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let updateResults = []
let queueResult = { data: [], error: null }
const patches = []

function builder(table) {
  const b = { op: 'select', patch: null }
  for (const m of ['select', 'eq', 'lt', 'gte', 'order', 'limit']) b[m] = () => b
  b.update = (patch) => { b.op = 'update'; b.patch = patch; return b }
  b.then = (resolve, reject) => {
    let out = { data: null, error: null }
    if (table === 'class_booking_requests') {
      if (b.op === 'update') {
        patches.push(b.patch)
        out = updateResults.shift() || { data: [], error: null }
      } else {
        out = queueResult
      }
    }
    return Promise.resolve(out).then(resolve, reject)
  }
  return b
}
const fakeDb = { from: (t) => builder(t) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/class-booking-queue', () => ({ claimAndProcessBookingJob: vi.fn(), MAX_ATTEMPTS: 3 }))
vi.mock('@/lib/class-booking-processor', () => ({ routeToReview: vi.fn(async () => ({ outcome: 'needs_review', detail: 'max_attempts_stuck_processing' })) }))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'
import { claimAndProcessBookingJob } from '@/lib/class-booking-queue'
import { routeToReview } from '@/lib/class-booking-processor'

const req = (auth = 'Bearer test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})
const ERR = { message: 'fetch failed' }
const ROW = { id: 'cbr-1', status: 'queued' }

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  updateResults = []
  patches.length = 0
  queueResult = { data: [], error: null }
  claimAndProcessBookingJob.mockResolvedValue({ status: 'processed', outcome: 'booked' })
})

describe('GET /api/cron/process-class-bookings — read errors (CRONREADERR.1)', () => {
  it('a failed queue read: 500, nothing claimed, heartbeat NOT stamped, logged', async () => {
    queueResult = { data: null, error: ERR }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
    expect(claimAndProcessBookingJob).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      'process-class-bookings',
      'queue read failed; nothing claimed, heartbeat not stamped',
      expect.objectContaining({ err: ERR }),
    )
  })

  it('a failed requeue: both reaper writes still attempted, reap_failed 1, the queue still runs, NOT stamped', async () => {
    updateResults = [{ data: null, error: ERR }, { data: null, error: null }]
    queueResult = { data: [ROW], error: null }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(patches).toHaveLength(2)
    expect(body).toMatchObject({ reap_failed: 1, reaped: 0, processed: 1, booked: 1 })
    expect(claimAndProcessBookingJob).toHaveBeenCalledWith(fakeDb, ROW)
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      'process-class-bookings',
      'reaper requeue failed; stuck rows wait for the next tick',
      expect.objectContaining({ err: ERR }),
    )
  })

  it('a failed needs_review flag: reap_failed 1, NOT stamped, logged', async () => {
    updateResults = [{ data: [{ id: 'x' }], error: null }, { data: null, error: ERR }]
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ reap_failed: 1, reaped: 1 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      'process-class-bookings',
      'reaper needs_review flag failed; stuck rows wait for the next tick',
      expect.objectContaining({ err: ERR }),
    )
  })

  it('a clean idle tick stamps, with reap_failed 0 in the outcome', async () => {
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('process-class-bookings', {
      reaped: 0, reap_carded: 0, processed: 0, booked: 0, review: 0, failed: 0, reap_failed: 0,
    })
    expect(routeToReview).not.toHaveBeenCalled()
  })
})

// REGISTRYREAD.1a — the reaper's past-the-cap flip used to leave a bare
// needs_review with no approvals card: on no screen. Every row the guarded
// flip matched now gets its card. (The card itself — one card, reuse, the
// review_unavailable fallback — runs against the real routeToReview in
// src/lib/class-booking-retries-exhausted.test.js.)
describe('GET /api/cron/process-class-bookings — stuck rows past the cap get a staff card', () => {
  const STUCK = [
    { id: 'cbr-7', status: 'needs_review', attempts: 3, approval_request_id: null },
    { id: 'cbr-8', status: 'needs_review', attempts: 4, approval_request_id: 'amr-2' },
  ]

  it('cards every row the flip matched, counts them, still stamps', async () => {
    updateResults = [{ data: [], error: null }, { data: STUCK, error: null }]
    const body = await (await GET(req())).json()
    expect(routeToReview).toHaveBeenCalledTimes(2)
    expect(routeToReview).toHaveBeenCalledWith(fakeDb, STUCK[0], 'max_attempts_stuck_processing')
    expect(routeToReview).toHaveBeenCalledWith(fakeDb, STUCK[1], 'max_attempts_stuck_processing')
    expect(body).toMatchObject({ reap_carded: 2, reap_failed: 0 })
    expect(stampHeartbeat).toHaveBeenCalled()
  })

  it('a row whose card could not be filed is logged; the others are still carded', async () => {
    updateResults = [{ data: [], error: null }, { data: STUCK, error: null }]
    routeToReview.mockResolvedValueOnce({ outcome: 'failed', detail: 'review_unavailable:max_attempts_stuck_processing' })
    const body = await (await GET(req())).json()
    expect(routeToReview).toHaveBeenCalledTimes(2)
    expect(body).toMatchObject({ reap_carded: 1 })
    expect(logError).toHaveBeenCalledWith(
      'process-class-bookings',
      'stuck row flagged but no staff card could be filed',
      expect.objectContaining({ requestId: 'cbr-7' }),
    )
  })

  it('a throw while carding one row never stops the next', async () => {
    updateResults = [{ data: [], error: null }, { data: STUCK, error: null }]
    routeToReview.mockRejectedValueOnce(new Error('boom'))
    const body = await (await GET(req())).json()
    expect(routeToReview).toHaveBeenCalledTimes(2)
    expect(body).toMatchObject({ reap_carded: 1 })
    expect(logError).toHaveBeenCalledWith(
      'process-class-bookings',
      'stuck row flagged but filing the staff card threw',
      expect.objectContaining({ requestId: 'cbr-7' }),
    )
  })

  it('a failed flip cards nothing', async () => {
    updateResults = [{ data: [], error: null }, { data: null, error: ERR }]
    await GET(req())
    expect(routeToReview).not.toHaveBeenCalled()
  })
})
