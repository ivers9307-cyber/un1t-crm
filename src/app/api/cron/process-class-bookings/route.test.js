// CRONREADERR.1 — the class-booking drain. A failed queue read is not "queue
// empty": 500, nothing claimed, no stamp. The reaper's two writes RESOLVE with
// { error } (a builder never throws), so the old try/catch never saw them:
// both are now attempted, then judged; a failure is logged, counted
// (reap_failed) and withholds the stamp, while the queue still runs.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let updateResults = []
let queueResult = { data: [], error: null }
const patches = []
const queueReads = []

function builder(table) {
  const b = { op: 'select', patch: null, ops: [] }
  for (const m of ['select', 'eq', 'lt', 'gte', 'order', 'limit']) b[m] = (...a) => { b.ops.push([m, ...a]); return b }
  b.update = (patch) => { b.op = 'update'; b.patch = patch; return b }
  b.then = (resolve, reject) => {
    let out = { data: null, error: null }
    if (table === 'class_booking_requests') {
      if (b.op === 'update') {
        patches.push(b.patch)
        out = updateResults.shift() || { data: [], error: null }
      } else {
        queueReads.push(b.ops)
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
  queueReads.length = 0
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

// FLOWACK.1 review — the sweeper never claims a row in its first moments: the
// WhatsApp Flow webhook acknowledges the customer and only THEN wakes the
// processor (QStash), so a sweep that claimed a just-queued row could deliver
// a fast outcome ("the team is confirming") ahead of "we're booking your spot".
describe('GET /api/cron/process-class-bookings — a just-queued row is left to its push', () => {
  it('reads only queued rows older than the grace', async () => {
    const before = Date.now()
    await GET(req())
    const read = queueReads.find((ops) => ops.some(([m, c, v]) => m === 'eq' && c === 'status' && v === 'queued'))
    const lt = read.find(([m, c]) => m === 'lt' && c === 'created_at')
    expect(lt).toBeTruthy()
    const cutoff = Date.parse(lt[2])
    expect(before - cutoff).toBeGreaterThanOrEqual(29_000)
    expect(before - cutoff).toBeLessThanOrEqual(31_000)
  })
})

// ROUTEWRAP.C7 — the job runs inside defineCron: the wrapper owns the secret
// check, the error boundary and the stamp.
describe('GET /api/cron/process-class-bookings — defineCron', () => {
  it('refuses a caller without the cron secret: nothing read, nothing stamped', async () => {
    const from = vi.spyOn(fakeDb, 'from')
    for (const auth of [null, 'Bearer nope']) expect((await GET(req(auth))).status).toBe(401)
    expect(from).not.toHaveBeenCalled()
    expect(claimAndProcessBookingJob).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    from.mockRestore()
  })

  it('a clean tick stamps exactly its own row, once', async () => {
    queueResult = { data: [ROW], error: null }
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, processed: 1, booked: 1 })
    expect(stampHeartbeat.mock.calls.map(([n]) => n)).toEqual(['process-class-bookings'])
  })

  it('a failed queue read answers a fixed line with no database text', async () => {
    queueResult = { data: null, error: { message: 'permission denied for table class_booking_requests' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'Could not read the booking queue' })
    expect(JSON.stringify(body)).not.toContain('permission denied')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a throw mid-run answers the wrapper fixed 500 and stamps nothing', async () => {
    queueResult = { data: [ROW], error: null }
    claimAndProcessBookingJob.mockRejectedValueOnce(new Error('socket hang up at db.internal'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Cron run failed' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
